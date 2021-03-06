import { ArangoError, HttpError } from "./error";
import {
  ArangojsResponse,
  RequestFunction,
  createRequest,
  isBrowser
} from "./util/request";

import { Errback } from "./util/types";
import { Route } from "./route";
import { byteLength } from "./util/bytelength";
import { stringify as querystringify } from "querystring";

const LinkedList = require("linkedlist/lib/linkedlist") as typeof Array;

const MIME_JSON = /\/(json|javascript)(\W|$)/;
const LEADER_ENDPOINT_HEADER = "x-arango-endpoint";

export type LoadBalancingStrategy = "NONE" | "ROUND_ROBIN" | "ONE_RANDOM";

type UrlInfo = {
  absolutePath?: boolean;
  basePath?: string;
  path?: string;
  qs?: string | { [key: string]: any };
};

export type RequestOptions = {
  host?: number;
  method?: string;
  body?: any;
  expectBinary?: boolean;
  isBinary?: boolean;
  isJsonStream?: boolean;
  headers?: { [key: string]: string };
  absolutePath?: boolean;
  basePath?: string;
  path?: string;
  qs?: string | { [key: string]: any };
};

type Task = {
  host?: number;
  resolve: Function;
  reject: Function;
  options: {
    method: string;
    expectBinary: boolean;
    url: { pathname: string; search?: string };
    headers: { [key: string]: string };
    body: any;
  };
};

export type Config =
  | string
  | string[]
  | Partial<{
      url: string | string[];
      isAbsolute: boolean;
      arangoVersion: number;
      loadBalancingStrategy: LoadBalancingStrategy;
      agent: Function;
      agentOptions: { [key: string]: any };
      headers: { [key: string]: string };
    }>;

export class Connection {
  private _activeTasks: number = 0;
  private _agent?: Function;
  private _agentOptions: { [key: string]: any };
  private _arangoVersion: number = 30000;
  private _databaseName: string | false = "_system";
  private _headers: { [key: string]: string };
  private _loadBalancingStrategy: LoadBalancingStrategy;
  private _useFailOver: boolean;
  private _maxTasks: number;
  private _queue: Task[] = new LinkedList();
  private _hosts: RequestFunction[] = [];
  private _urls: string[] = [];
  private _activeHost: number;

  constructor(config: Config = {}) {
    if (typeof config === "string") config = { url: config };
    else if (Array.isArray(config)) config = { url: config };

    if (config.arangoVersion !== undefined) {
      this._arangoVersion = config.arangoVersion;
    }
    if (config.isAbsolute) {
      this._databaseName = false;
    }
    this._agent = config.agent;
    this._agentOptions = isBrowser
      ? { ...config.agentOptions! }
      : {
          maxSockets: 3,
          keepAlive: true,
          keepAliveMsecs: 1000,
          ...config.agentOptions
        };
    this._maxTasks = this._agentOptions.maxSockets || 3;
    if (this._agentOptions.keepAlive) this._maxTasks *= 2;

    this._headers = { ...config.headers };
    this._loadBalancingStrategy = config.loadBalancingStrategy || "NONE";
    this._useFailOver = this._loadBalancingStrategy !== "ROUND_ROBIN";

    const urls = config.url
      ? Array.isArray(config.url) ? config.url : [config.url]
      : ["http://localhost:8529"];
    this.addToHostList(urls);

    if (this._loadBalancingStrategy === "ONE_RANDOM") {
      this._activeHost = Math.floor(Math.random() * this._hosts.length);
    } else {
      this._activeHost = 0;
    }
  }

  private get _databasePath() {
    return this._databaseName === false ? "" : `/_db/${this._databaseName}`;
  }

  private _runQueue() {
    if (!this._queue.length || this._activeTasks >= this._maxTasks) return;
    const task = this._queue.shift()!;
    let host = this._activeHost;
    if (task.host !== undefined) {
      host = task.host;
    } else if (this._loadBalancingStrategy === "ROUND_ROBIN") {
      this._activeHost = (this._activeHost + 1) % this._hosts.length;
    }
    this._activeTasks += 1;
    this._hosts[host](task.options, (err, res) => {
      this._activeTasks -= 1;
      if (err) {
        if (
          this._hosts.length > 1 &&
          this._activeHost === host &&
          this._useFailOver
        ) {
          this._activeHost = (this._activeHost + 1) % this._hosts.length;
        }
        task.reject(err);
      } else {
        const response = res!;
        if (
          response.statusCode === 503 &&
          response.headers[LEADER_ENDPOINT_HEADER]
        ) {
          const url = response.headers[LEADER_ENDPOINT_HEADER]!;
          const [index] = this.addToHostList(url);
          task.host = index;
          if (this._activeHost === host) {
            this._activeHost = index;
          }
          this._queue.push(task);
        } else {
          response.host = host;
          task.resolve(response);
        }
      }
      this._runQueue();
    });
  }

  private _buildUrl({ absolutePath = false, basePath, path, qs }: UrlInfo) {
    let pathname = "";
    let search;
    if (!absolutePath) {
      pathname = this._databasePath;
      if (basePath) pathname += basePath;
    }
    if (path) pathname += path;
    if (qs) {
      if (typeof qs === "string") search = `?${qs}`;
      else search = `?${querystringify(qs)}`;
    }
    return search ? { pathname, search } : { pathname };
  }

  private _sanitizeEndpointUrl(url: string): string {
    if (url.startsWith("tcp:")) return url.replace(/^tcp:/, "http:");
    if (url.startsWith("ssl:")) return url.replace(/^ssl:/, "https:");
    return url;
  }

  addToHostList(urls: string | string[]): number[] {
    const cleanUrls = (Array.isArray(urls) ? urls : [urls]).map(url =>
      this._sanitizeEndpointUrl(url)
    );
    const newUrls = cleanUrls.filter(url => this._urls.indexOf(url) === -1);
    this._urls.push(...newUrls);
    this._hosts.push(
      ...newUrls.map((url: string) =>
        createRequest(url, this._agentOptions, this._agent)
      )
    );
    return cleanUrls.map(url => this._urls.indexOf(url));
  }

  get arangoMajor() {
    return Math.floor(this._arangoVersion / 10000);
  }

  getDatabaseName() {
    return this._databaseName;
  }

  getActiveHost() {
    return this._activeHost;
  }

  setDatabaseName(databaseName: string) {
    if (this._databaseName === false) {
      throw new Error("Can not change database from absolute URL");
    }
    this._databaseName = databaseName;
  }

  setHeader(key: string, value: string) {
    this._headers[key] = value;
  }

  route(path?: string, headers?: Object) {
    return new Route(this, path, headers);
  }

  request(
    {
      host,
      method = "GET",
      body,
      expectBinary = false,
      isBinary = false,
      isJsonStream = false,
      headers,
      ...urlInfo
    }: RequestOptions,
    cb: Errback<ArangojsResponse>
  ) {
    let contentType = "text/plain";
    if (isBinary) {
      contentType = "application/octet-stream";
    } else if (body) {
      if (typeof body === "object") {
        if (isJsonStream) {
          body =
            body.map((obj: any) => JSON.stringify(obj)).join("\r\n") + "\r\n";
          contentType = "application/x-ldjson";
        } else {
          body = JSON.stringify(body);
          contentType = "application/json";
        }
      } else {
        body = String(body);
      }
    }

    const extraHeaders: { [key: string]: string } = {
      ...this._headers,
      "content-type": contentType,
      "x-arango-version": String(this._arangoVersion)
    };

    if (!isBrowser) {
      // Node doesn't set content-length but ArangoDB needs it
      extraHeaders["content-length"] = String(
        body ? byteLength(body, "utf-8") : 0
      );
    }

    this._queue.push({
      host,
      options: {
        url: this._buildUrl(urlInfo),
        headers: { ...extraHeaders, ...headers },
        method,
        expectBinary,
        body
      },
      reject: (err: Error) => cb(err),
      resolve: (res: ArangojsResponse) => {
        const contentType = res.headers["content-type"];
        let parsedBody: any = undefined;
        if (res.body.length && contentType && contentType.match(MIME_JSON)) {
          try {
            parsedBody = res.body;
            parsedBody = JSON.parse(parsedBody);
          } catch (e) {
            if (!expectBinary) {
              if (typeof parsedBody !== "string") {
                parsedBody = res.body.toString("utf-8");
              }
              e.response = res;
              cb(e);
              return;
            }
          }
        } else if (res.body && !expectBinary) {
          parsedBody = res.body.toString("utf-8");
        } else {
          parsedBody = res.body;
        }
        if (
          parsedBody &&
          parsedBody.hasOwnProperty("error") &&
          parsedBody.hasOwnProperty("code") &&
          parsedBody.hasOwnProperty("errorMessage") &&
          parsedBody.hasOwnProperty("errorNum")
        ) {
          res.body = parsedBody;
          cb(new ArangoError(res));
        } else if (res.statusCode && res.statusCode >= 400) {
          res.body = parsedBody;
          cb(new HttpError(res));
        } else {
          if (!expectBinary) res.body = parsedBody;
          cb(null, res);
        }
      }
    });
    this._runQueue();
  }
}
