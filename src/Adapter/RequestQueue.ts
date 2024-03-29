import { AxiosRequestConfig, AxiosResponse } from 'axios';
import hashIt from 'hash-it';

/**
 * The request controller that can be used to cancel the request.
 */
export interface RequestController {
  /**
   * Cancels the request.
   */
  cancelRequest: () => void;
}

/**
 * The function that will be called to process the response before it is returned to the caller.
 */
export type ResponseProcessor = <T = any>(
  response: AxiosResponse<T>
) => AxiosResponse<any>;

export interface RequestOptions<T = any> extends AxiosRequestConfig<T> {
  /**
   * A function that will be called with the request controller
   */
  getRequestController?: (controller: RequestController) => void;

  /**
   * The label of the request.
   * @example 'Loading users'
   */
  label?: string;

  /**
   * The id of the cache to use when caching the response data or looking for cached data.
   */
  cacheId?: string;

  /**
   * The function that will be called to process the response before it is returned to the caller.
   */
  processResponse?: ResponseProcessor;

  /**
   * The function that will be called when the request is successful.
   * This is called before the request is resolved. This will not be called if the request data is cached.
   * @param response The response from the server after the request has been made.
   */
  onServerSuccess?: (response: AxiosResponse<T>) => void;

  /**
   * The function that will be called when there is stale data in the cache. The function will be called before the request is made.
   *
   * @param staleData The stale data that was returned from the cache.
   */
  getStaleWhileRevalidate?: (staleData: T) => void;

  /**
   * The query params to add to the request url.
   */
  queryParams?: Record<string, any>;
}

type Resolve = (payload?: any) => void;

type Reject = (err?: any) => void;

/**
 * The options of a queued request.
 */
interface QueuedRequestOptions extends RequestOptions {
  /**
   * The url of the request.
   */
  url: string;

  /**
   * The function that will be called to resolve the request.
   */
  resolve: Resolve;

  /**
   * The function that will be called to reject the request.
   */
  reject: Reject;
}

const requestQueue: Record<string, QueuedRequestOptions[]> = {};

/**
 * Queues a request to be made. Requests with exactly the same options will be queued together.
 * The request will be made when the first request with the same options is made, the resolve and
 * reject functions will be called for all the requests with the same options.
 *
 * @param requestOptions The options of the request.
 * @param callback The function that will be called to resolve or reject the request.
 */
export const queueRequest = (
  requestOptions: QueuedRequestOptions,
  callback: (resolve: Resolve, reject: Reject) => void
) => {
  const hashableRequestOptions = { ...requestOptions };
  if (
    typeof FormData !== 'undefined' &&
    hashableRequestOptions.data instanceof FormData
  ) {
    hashableRequestOptions.data = Date.now();
  }
  const requestId = String(hashIt(hashableRequestOptions));
  if (requestQueue[requestId]) {
    requestQueue[requestId].push(requestOptions);
  } else {
    requestQueue[requestId] = [requestOptions];
    callback(
      (payload) => {
        resolveRequest(requestId, payload);
      },
      (err) => {
        rejectRequest(requestId, err);
      }
    );
  }
};

/**
 * Dequeues a request.
 *
 * @param url The url of the request.
 */
const dequeueRequest = (url: string) => {
  delete requestQueue[url];
};

/**
 * Resolves a request.
 *
 * @param requestKey The key of the request.
 * @param payload The payload to resolve the request with.
 */
const resolveRequest = (requestKey: string, payload: any) => {
  if (requestQueue[requestKey]?.length > 0) {
    requestQueue[requestKey].forEach(({ resolve }) => {
      resolve(payload);
    });
    dequeueRequest(requestKey);
  }
};

/**
 * Rejects a request.
 *
 * @param requestKey The key of the request.
 * @param err The error to reject the request with.
 */
const rejectRequest = (requestKey: string, err: any) => {
  if (requestQueue[requestKey]?.length > 0) {
    requestQueue[requestKey].forEach(({ reject }) => {
      reject(err);
    });
    dequeueRequest(requestKey);
  }
};
