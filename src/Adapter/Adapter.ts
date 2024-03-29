import { addSearchParams } from '@infinite-debugger/rmk-utils/paths';
import StorageManager from '@infinite-debugger/rmk-utils/StorageManager';
import axios, { AxiosError, AxiosResponse, CancelTokenSource } from 'axios';
import hashIt from 'hash-it';

import {
  RequestOptions,
  ResponseProcessor,
  queueRequest,
} from './RequestQueue';

export { RequestOptions, ResponseProcessor };

export const CANCELLED_API_REQUEST_MESSAGE = 'Request Cancelled';

export const EXPIRED_SESSION_ERROR_MESSAGES = [
  'Session timed out',
  'Session expired',
  'User session timed out',
  'User session expired',
  'Invalid token',
];

/**
 * The API request cache. This is used to cache the API responses.
 */
export interface APIRequestCache {
  /**
   * Finds the cached data. If not found, it will fetch the data from the API and cache it.
   *
   * @param cacheId The id of the data cache. This is used to identify the cache to look for.
   * @param requestId The id of the request. This is used to identify the request to look for in the selected data cache.
   * @param requestOptions The request options.
   * @returns The cached data or null if not found.
   */
  getCachedData: <T = any>(
    cacheId: string,
    requestId: string,
    requestOptions: RequestOptions
  ) => Promise<{
    isStale?: boolean;
    data: T;
  } | null>;

  /**
   * Caches the response data in the selected data cache.
   *
   * @param cacheId The id of the data cache. This is used to identify the cache to look for.
   * @param requestId The id of the request. This is used to identify the request to look for in the selected data cache.
   * @param data The data to cache
   * @param requestOptions The request options.
   * @returns True if the data was cached successfully and false otherwise.
   */
  cacheData: <T = any>(
    cacheId: string,
    requestId: string,
    data: {
      isStale?: boolean;
      data: T;
    },
    requestOptions: RequestOptions
  ) => Promise<boolean>;
}

/**
 * The API adapter configuration. This is used to configure the API adapter.
 */
export interface IAPIAdapterConfiguration {
  /**
   * Host URL for the API
   */
  HOST_URL: string;

  /**
   * Returns the full URL to the resource
   *
   * @param path The path to the resource
   * @returns The full URL to the resource
   * @example getFullResourceURL('/users') // https://example.com/users
   */
  getFullResourceURL: (path: string) => string;

  /**
   * Whether to pre-process the error messages in the response
   */
  preProcessResponseErrorMessages: boolean;

  /**
   * The cache to use for caching the API responses
   */
  cache?: APIRequestCache;

  /**
   * The default request options
   */
  defaultRequestOptions?: RequestOptions;
}

export type RequestErrorEvent = {
  type: 'error';
  error: AxiosError;
};

export type RequestErrorEventListenerFunction = (
  event: RequestErrorEvent
) => void;

export type AddRequestErrorEventListenerFunction<RequestController> = (
  event: 'error',
  listener: RequestErrorEventListenerFunction
) => ThisType<RequestController>;

export type AddRequestEventListener<RequestController> =
  AddRequestErrorEventListenerFunction<RequestController>;

/**
 * The request controller. This is used to control the request before it is sent and after a
 * response is received.
 */
export interface RequestController {
  readonly addEventListener: AddRequestEventListener<this>;
  readonly removeEventListener: AddRequestEventListener<this>;

  /**
   * Function that processes the response before it is returned. This is useful for
   * extracting response headers and appending them to the default request headers.
   *
   * @param responseHeaders The response headers.
   * @param requestHeaders The request headers.
   * @returns The new headers that should be appended to the default request headers.
   */
  rotateHeaders?: (
    responseHeaders: Record<string, string>,
    requestHeaders: Record<string, string>
  ) => Record<string, string> | undefined;

  /**
   * Function that processes the response before it is returned.
   */
  processResponse?: ResponseProcessor;

  /**
   * Function that processes the response error before it is returned.
   *
   * @param err The response error.
   * @returns The new error.
   */
  processResponseError?: (err: AxiosError<any>) => any;

  /**
   * Function that determines whether to retry the request or not.
   *
   * @param err The response error.
   * @param numberOfTrials The number of times the request has been retried.
   * @returns Whether to retry the request or not.
   */
  shouldRetryRequest?: (
    err: AxiosError<any>,
    numberOfTrials: number
  ) => Promise<boolean>;
}

/**
 * The options for the API adapter.
 */
export interface GetAPIAdapterOptions {
  /**
   * The id of the API adapter. This is used to identify the API adapter in the storage.
   */
  id?: string;

  /**
   * The host URL for the API. If not provided, it will be extracted from the window object.
   */
  hostUrl?: string;
}

/**
 * Returns the API adapter.
 *
 * @param options The options for the API adapter.
 * @returns The API adapter.
 */
export const getAPIAdapter = ({ id, hostUrl }: GetAPIAdapterOptions = {}) => {
  const HOST_URL = (() => {
    if (hostUrl) {
      return hostUrl;
    }
    if (typeof window !== 'undefined') {
      return window.location.origin;
    }
    return '';
  })();

  const eventsQueue: {
    error: RequestErrorEventListenerFunction[];
  } = {
    error: [],
  };

  const { defaultRequestHeadersStorageKey } = (() => {
    let defaultRequestHeadersStorageKey = 'defaultRequestHeaders';

    if (id) {
      defaultRequestHeadersStorageKey += id;
    }

    return {
      defaultRequestHeadersStorageKey,
    };
  })();

  const FAILED_REQUEST_RETRY_STATUS_BLACKLIST: number[] = [400, 401, 500];
  const MAX_REQUEST_RETRY_COUNT = 2;

  const APIAdapterConfiguration: IAPIAdapterConfiguration = {
    HOST_URL,
    getFullResourceURL: (path) => {
      if (path.match(/^https?:/)) return path;
      return APIAdapterConfiguration.HOST_URL + path;
    },
    preProcessResponseErrorMessages: true,
  };

  const defaultRequestHeaders: Record<string, string> = {};

  const setDefaultRequestHeaders = () => {
    const cachedDefaultRequestHeaders: Record<string, string> | null =
      StorageManager.get(defaultRequestHeadersStorageKey);
    cachedDefaultRequestHeaders &&
      Object.assign(defaultRequestHeaders, cachedDefaultRequestHeaders);
  };
  setDefaultRequestHeaders();

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', setDefaultRequestHeaders);
  }

  /**
   * Adds the headers to the default request headers.
   *
   * @param headers The headers to append to the default request headers.
   */
  const patchDefaultRequestHeaders = (headers?: Record<string, string>) => {
    Object.assign(defaultRequestHeaders, headers);
    StorageManager.add(defaultRequestHeadersStorageKey, defaultRequestHeaders);
  };

  /**
   * Clears the default request headers
   */
  const clearDefaultRequestHeaders = () => {
    Object.keys(defaultRequestHeaders).forEach((key) => {
      delete defaultRequestHeaders[key];
    });
    StorageManager.remove(defaultRequestHeadersStorageKey);
  };

  const RequestController: RequestController = {
    addEventListener: (event, listener) => {
      eventsQueue[event].push(listener);
      return RequestController;
    },
    removeEventListener: (event, listener) => {
      const index = eventsQueue[event].indexOf(listener);
      if (index > -1) {
        eventsQueue[event].splice(index, 1);
      }
      return RequestController;
    },
  };

  const pendingRequestCancelTokenSources: CancelTokenSource[] = [];

  /**
   * Fetches the data from the API.
   *
   * @param path The path to the resource.
   * @param param1 The request options.
   * @returns The response.
   */
  const fetchData = async <Data = any>(
    path: string,
    inputOptions: RequestOptions
  ): Promise<AxiosResponse<Data>> => {
    const {
      headers = {},
      label = 'operation',
      processResponse,
      cacheId,
      onServerSuccess,
      getStaleWhileRevalidate,
      queryParams,
      ...options
    } = { ...APIAdapterConfiguration.defaultRequestOptions, ...inputOptions };
    const url = (() => {
      const baseUrl = APIAdapterConfiguration.getFullResourceURL(path);
      if (queryParams) {
        return addSearchParams(baseUrl, queryParams, {
          arrayParamStyle: 'append',
        });
      }
      return baseUrl;
    })();

    return new Promise((resolve, reject) => {
      const requestId = String(
        hashIt({
          ...options,
          url,
        })
      );

      //#region Queue the request
      queueRequest(
        {
          ...options,
          url,
          resolve,
          reject,
        },
        async (resolve, reject) => {
          //#region Check if the request is already cached
          if (
            cacheId &&
            APIAdapterConfiguration.cache &&
            (!options.method ||
              options.method === 'get' ||
              options.method === 'GET')
          ) {
            const cachedData =
              await APIAdapterConfiguration.cache.getCachedData(
                cacheId,
                requestId,
                {
                  url,
                  headers,
                  ...options,
                }
              );
            if (cachedData) {
              const { data, isStale } = cachedData;

              if (isStale) {
                if (getStaleWhileRevalidate) {
                  try {
                    getStaleWhileRevalidate(data);
                  } catch (err) {
                    console.error(err);
                  }
                }
              } else {
                resolve({
                  data,
                });
                return;
              }
            }
          }
          //#endregion

          /**
           * Fetches the data from the API.
           *
           * @param retryCount The number of times the request has been retried.
           * @returns The response.
           */
          const fetchData = async (retryCount = 0): Promise<any> => {
            const cancelTokenSource = axios.CancelToken.source();
            options.getRequestController &&
              options.getRequestController({
                cancelRequest: () => {
                  cancelTokenSource.cancel(CANCELLED_API_REQUEST_MESSAGE);
                },
              });
            pendingRequestCancelTokenSources.push(cancelTokenSource);

            //#region Make axios request to the API
            const response = await axios(url, {
              ...options,
              headers: {
                ...defaultRequestHeaders,
                ...headers,
              } as any,
              cancelToken: cancelTokenSource.token,
              withCredentials: true,
            })
              .then(async (response) => {
                const requestControllerResponse = await (() => {
                  if (RequestController.processResponse) {
                    return RequestController.processResponse(response);
                  }
                  return response;
                })();
                if (processResponse) {
                  return processResponse(requestControllerResponse);
                }
                return response;
              })
              .catch(async (err: AxiosError) => {
                const requestWillRetry = await (async () => {
                  const shouldRetryRequest = await (async () => {
                    if (RequestController.shouldRetryRequest) {
                      return RequestController.shouldRetryRequest(
                        err,
                        retryCount
                      );
                    }
                    return false;
                  })();

                  return (
                    shouldRetryRequest ||
                    (response &&
                      !FAILED_REQUEST_RETRY_STATUS_BLACKLIST.includes(
                        response.status
                      ) &&
                      retryCount < MAX_REQUEST_RETRY_COUNT)
                  );
                })();
                if (RequestController.processResponseError) {
                  err = await RequestController.processResponseError(err);
                }

                //#region Emit the error event
                eventsQueue.error.forEach((listener) => {
                  listener({
                    type: 'error',
                    error: err,
                  });
                });
                //#endregion

                if (APIAdapterConfiguration.preProcessResponseErrorMessages) {
                  pendingRequestCancelTokenSources.splice(
                    pendingRequestCancelTokenSources.indexOf(cancelTokenSource),
                    1
                  );
                  const cancelPendingRequests = () => {
                    [...pendingRequestCancelTokenSources].forEach(
                      (cancelTokenSource) => cancelTokenSource.cancel()
                    );
                  };
                  const { response, message } = err as any;
                  const errorMessage = (() => {
                    if (response?.data) {
                      //#region Extracting server side error message
                      const message = (() => {
                        if (typeof response.data.message === 'string') {
                          return response.data.message;
                        }
                        if (Array.isArray(response.data.message)) {
                          return response.data.message
                            .filter(
                              (message: any) => typeof message === 'string'
                            )
                            .join('\n');
                        }
                        if (
                          Array.isArray(response.data.errors) &&
                          response.data.errors.length > 0
                        ) {
                          return response.data.errors
                            .map((err: any) => {
                              return err.message;
                            })
                            .join('\n');
                        }
                        return 'Something went wrong';
                      })();
                      //#endregion

                      //#region Cancel all pending requests if the error message is a session timeout error
                      if (EXPIRED_SESSION_ERROR_MESSAGES.includes(message)) {
                        cancelPendingRequests();
                        return message;
                      }
                      //#endregion

                      return `Error: '${label}' failed with message "${message}"`;
                    }
                    if (
                      message &&
                      !String(message).match(/request\sfailed/gi)
                    ) {
                      return `Error: '${label}' failed with message "${message}"`;
                    }
                    return `Error: '${label}' failed. Something went wrong`;
                  })();

                  if (!requestWillRetry) {
                    return reject(Error(errorMessage));
                  }
                }

                if (requestWillRetry) {
                  return fetchData(retryCount + 1);
                }

                return reject(err);
              });
            //#endregion

            if (response) {
              pendingRequestCancelTokenSources.splice(
                pendingRequestCancelTokenSources.indexOf(cancelTokenSource),
                1
              );
              if (RequestController.rotateHeaders) {
                patchDefaultRequestHeaders(
                  RequestController.rotateHeaders(
                    response.headers as any,
                    defaultRequestHeaders
                  )
                );
              }

              //#region Cache the response data
              if (cacheId && APIAdapterConfiguration.cache) {
                await APIAdapterConfiguration.cache
                  .cacheData(
                    cacheId,
                    requestId,
                    {
                      data: response.data,
                    },
                    {
                      url,
                      headers,
                      ...options,
                    }
                  )
                  .catch((err) => {
                    err; // Caching failed
                  });
              }
              //#endregion

              onServerSuccess && onServerSuccess(response);
              return resolve(response);
            }
          };
          fetchData();
        }
      );
      //#endregion
    });
  };

  /**
   * Returns the request options with the default options patched.
   *
   * @param options The request options.
   * @returns The request options with the default options patched.
   */
  const getRequestDefaultOptions = ({ ...options }: RequestOptions = {}) => {
    options.headers || (options.headers = {});

    if (options.data && !(options.headers as any)['Content-Type']) {
      if (typeof FormData !== 'undefined' && options.data instanceof FormData) {
        (options.headers as any)['Content-Type'] = 'multipart/form-data';
      } else if (typeof options.data === 'object') {
        options.data = JSON.stringify(options.data);
        (options.headers as any)['Content-Type'] = 'application/json';
      }
    }

    return options;
  };

  /**
   * Fetches the data from the API using the GET method.
   *
   * @param path The path to the resource.
   * @param options The request options.
   * @returns The response.
   */
  const get = <Data = any>(path: string, options: RequestOptions = {}) => {
    return fetchData<Data>(path, options);
  };

  /**
   * Fetches the data from the API using the POST method.
   * @param path The path to the resource.
   * @param options The request options.
   * @returns The response.
   */
  const post = async <Data = any>(
    path: string,
    { ...options }: RequestOptions = {}
  ) => {
    options.method = 'POST';
    return fetchData<Data>(path, getRequestDefaultOptions(options));
  };

  /**
   * Fetches the data from the API using the PUT method.
   *
   * @param path The path to the resource.
   * @param options The request options.
   * @returns The response.
   */
  const put = async <Data = any>(
    path: string,
    { ...options }: RequestOptions = {}
  ) => {
    options.method = 'PUT';
    return fetchData<Data>(path, getRequestDefaultOptions(options));
  };

  /**
   * Fetches the data from the API using the PATCH method.
   *
   * @param path The path to the resource.
   * @param options The request options.
   * @returns The response.
   */
  const patch = async <Data = any>(
    path: string,
    { ...options }: RequestOptions = {}
  ) => {
    options.method = 'PATCH';
    return fetchData<Data>(path, getRequestDefaultOptions(options));
  };

  /**
   * Fetches the data from the API using the DELETE method.
   *
   * @param path The path to the resource.
   * @param options The request options.
   * @returns The response.
   */
  const _delete = <Data = any>(path: string, options: RequestOptions = {}) => {
    options.method = 'DELETE';
    return fetchData<Data>(path, options);
  };

  const logout = async () => {
    clearDefaultRequestHeaders();
  };

  return {
    get,
    post,
    put,
    patch,
    _delete,
    logout,
    RequestController,
    APIAdapterConfiguration,
    defaultRequestHeaders,
    patchDefaultRequestHeaders,
    clearDefaultRequestHeaders,
  };
};

const {
  APIAdapterConfiguration,
  RequestController,
  _delete,
  defaultRequestHeaders,
  get,
  logout,
  patch,
  patchDefaultRequestHeaders,
  post,
  put,
} = getAPIAdapter();

export {
  APIAdapterConfiguration,
  RequestController,
  _delete,
  defaultRequestHeaders,
  get,
  logout,
  patch,
  patchDefaultRequestHeaders,
  post,
  put,
};
