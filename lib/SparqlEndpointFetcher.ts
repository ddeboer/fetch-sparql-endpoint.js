import "isomorphic-fetch";
import * as RDF from "rdf-js";
import {Parser as SparqlParser} from "sparqljs";
import {Transform} from "stream";

// tslint:disable-next-line:no-var-requires
const n3 = require('n3');

/**
 * A SparqlEndpointFetcher can send queries to SPARQL endpoints,
 * and retrieve and parse the results.
 */
export class SparqlEndpointFetcher {

  public static CONTENTTYPE_SPARQL_JSON: string = 'application/sparql-results+json';
  public static CONTENTTYPE_TURTLE: string = 'text/turtle';

  public readonly fetchCb: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  public readonly dataFactory: RDF.DataFactory;

  constructor(args?: ISparqlEndpointFetcherArgs) {
    args = args || {};
    this.fetchCb = args.fetch || fetch;
    this.dataFactory = args.dataFactory || require('rdf-data-model');
  }

  /**
   * Convert a SPARQL JSON result binding to a bindings object.
   * @param rawBindings A SPARQL json result binding.
   * @return {Bindings} A bindings object.
   */
  public parseJsonBindings(rawBindings: any): IBindings {
    const bindings: IBindings = {};
    for (const key in rawBindings) {
      const rawValue: any = rawBindings[key];
      let value: RDF.Term = null;
      switch (rawValue.type) {
      case 'bnode':
        value = this.dataFactory.blankNode(rawValue.value);
        break;
      case 'literal':
        if (rawValue['xml:lang']) {
          value = this.dataFactory.literal(rawValue.value, rawValue['xml:lang']);
        } else if (rawValue.datatype) {
          value = this.dataFactory.literal(rawValue.value, this.dataFactory.namedNode(rawValue.datatype));
        } else {
          value = this.dataFactory.literal(rawValue.value);
        }
        break;
      default:
        value = this.dataFactory.namedNode(rawValue.value);
        break;
      }
      bindings['?' + key] = value;
    }
    return bindings;
  }

  /**
   * Get the query type of the given query.
   *
   * This will parse the query and thrown an exception on syntax errors.
   *
   * @param {string} query A query.
   * @return {"SELECT" | "ASK" | "CONSTRUCT" | "UNKNOWN"} The query type.
   */
  public getQueryType(query: string): "SELECT" | "ASK" | "CONSTRUCT" | "UNKNOWN" {
    const parsedQuery = new SparqlParser().parse(query);
    return parsedQuery.type === 'query'
      ? (parsedQuery.queryType === 'DESCRIBE' ? 'CONSTRUCT' : parsedQuery.queryType) : "UNKNOWN";
  }

  /**
   * Send a SELECT query to the given endpoint URL and return the resulting bindings stream.
   * @see IBindings
   * @param {string} endpoint A SPARQL endpoint URL. (without the `?query=` suffix).
   * @param {string} query    A SPARQL query string.
   * @return {Promise<NodeJS.ReadableStream>} A stream of {@link IBindings}.
   */
  public async fetchBindings(endpoint: string, query: string): Promise<NodeJS.ReadableStream> {
    const rawStream = await this.fetchRawStream(endpoint, query, SparqlEndpointFetcher.CONTENTTYPE_SPARQL_JSON);
    return rawStream
      .pipe(require('JSONStream').parse('results.bindings.*'))
      .pipe(new Transform({
        objectMode: true,
        transform: (rawBinding, encoding, cb) => cb(null, this.parseJsonBindings(rawBinding)),
      }));
  }

  /**
   * Send an ASK query to the given endpoint URL and return a promise resolving to the boolean answer.
   * @param {string} endpoint A SPARQL endpoint URL. (without the `?query=` suffix).
   * @param {string} query    A SPARQL query string.
   * @return {Promise<boolean>} A boolean resolving to the answer.
   */
  public async fetchAsk(endpoint: string, query: string): Promise<boolean> {
    const rawStream = await this.fetchRawStream(endpoint, query, SparqlEndpointFetcher.CONTENTTYPE_SPARQL_JSON);
    return new Promise<boolean>((resolve, reject) => {
      rawStream
        .pipe(require('JSONStream').parse('boolean'))
        .on('data', resolve)
        .on('end', () => reject(new Error('No valid ASK response was found.')));
    });
  }

  /**
   * Send a CONSTRUCT/DESCRIBE query to the given endpoint URL and return the resulting triple stream.
   * @param {string} endpoint A SPARQL endpoint URL. (without the `?query=` suffix).
   * @param {string} query    A SPARQL query string.
   * @return {Promise<Stream>} A stream of triples.
   */
  public async fetchTriples(endpoint: string, query: string): Promise<RDF.Stream> {
    const rawStream = await this.fetchRawStream(endpoint, query, SparqlEndpointFetcher.CONTENTTYPE_TURTLE);
    return rawStream.pipe(new n3.StreamParser({ format: SparqlEndpointFetcher.CONTENTTYPE_TURTLE }));
  }

  /**
   * Send a query to the given endpoint URL and return the resulting stream.
   *
   * This will only accept responses with the application/sparql-results+json content type.
   *
   * @param {string} endpoint     A SPARQL endpoint URL. (without the `?query=` suffix).
   * @param {string} query        A SPARQL query string.
   * @param {string} acceptHeader The HTTP accept to use.
   * @return {Promise<NodeJS.ReadableStream>} The SPARQL endpoint response stream.
   */
  public async fetchRawStream(endpoint: string, query: string, acceptHeader: string): Promise<NodeJS.ReadableStream> {
    const url: string = endpoint + '?query=' + encodeURIComponent(query);

    // Initiate request
    const headers: Headers = new Headers();
    headers.append('Accept', acceptHeader);
    const httpResponse: Response = await this.fetchCb(url, { headers });

    // Wrap WhatWG readable stream into a Node.js readable stream
    // If the body already is a Node.js stream (in the case of node-fetch), don't do explicit conversion.
    const responseStream: NodeJS.ReadableStream = require('is-stream')(httpResponse.body)
      ? httpResponse.body : require('node-web-streams').toNodeReadable(httpResponse.body);

    // Emit an error if the server returned an invalid response
    if (!httpResponse.ok) {
      setImmediate(() => responseStream.emit('error',
        new Error('Invalid SPARQL endpoint (' + endpoint + ') response: ' + httpResponse.statusText)));
    }

    return responseStream;
  }

}

export interface ISparqlEndpointFetcherArgs {
  fetch?: (input?: Request | string, init?: RequestInit) => Promise<Response>;
  dataFactory?: RDF.DataFactory;
}

export interface IBindings {
  [key: string]: RDF.Term;
}
