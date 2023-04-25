import { AxiosRequestConfig, AxiosResponse } from 'axios';
import hashIt from 'hash-it';

export interface RequestController {
  cancelRequest: () => void;
}

export type ResponseProcessor = <T = any>(
  response: AxiosResponse<T>
) => AxiosResponse<any>;

export interface RequestOptions extends AxiosRequestConfig {
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
}

type Resolve = (payload?: any) => void;

type Reject = (err?: any) => void;

interface QueuedRequestOptions extends RequestOptions {
  url: string;
  resolve: Resolve;
  reject: Reject;
}

const requestQueue: Record<string, QueuedRequestOptions[]> = {};

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

const dequeueRequest = (url: string) => {
  delete requestQueue[url];
};

const resolveRequest = (requestKey: string, payload: any) => {
  if (requestQueue[requestKey]?.length > 0) {
    requestQueue[requestKey].forEach(({ resolve }) => {
      resolve(payload);
    });
    dequeueRequest(requestKey);
  }
};

const rejectRequest = (requestKey: string, err: any) => {
  if (requestQueue[requestKey]?.length > 0) {
    requestQueue[requestKey].forEach(({ reject }) => {
      reject(err);
    });
    dequeueRequest(requestKey);
  }
};
