import StorageManager from '@infinite-debugger/rmk-utils/StorageManager';
import axios, { AxiosError, AxiosResponse, CancelTokenSource } from 'axios';
import hashIt from 'hash-it';

import { CANCELLED_API_REQUEST_MESSAGE } from '../constants';
import {
  RequestOptions,
  ResponseProcessor,
  queueRequest,
} from './RequestQueue';

export { RequestOptions, ResponseProcessor };

export const REDIRECTION_ERROR_MESSAGES = [
  'User session timed out',
  'Session timed out',
  'Invalid token',
  'Session expired',
  'User session expired',
];

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
}

export interface RequestController {
  rotateHeaders?: (
    responseHeaders: Record<string, string>,
    requestHeaders: Record<string, string>
  ) => Record<string, string>;
  processResponse?: ResponseProcessor;
  processResponseError?: (err: AxiosError<any>) => any;
  shouldRetryRequest?: (
    err: AxiosError<any>,
    numberOfTrials: number
  ) => Promise<boolean>;
}

export interface GetAPIAdapterOptions {
  id?: string;
  hostUrl?: string;
}

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

  const { defaultRequestHeadersStorageKey, tokenStorageKey } = (() => {
    let defaultRequestHeadersStorageKey = 'defaultRequestHeaders';
    let tokenStorageKey = 'token';

    if (id) {
      defaultRequestHeadersStorageKey += id;
      tokenStorageKey += id;
    }

    return {
      defaultRequestHeadersStorageKey,
      tokenStorageKey,
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

  const patchDefaultRequestHeaders = (headers: Record<string, string>) => {
    Object.assign(defaultRequestHeaders, headers);
    StorageManager.add(defaultRequestHeadersStorageKey, defaultRequestHeaders);
  };

  const RequestController: RequestController = {};

  const pendingRequestCancelTokenSources: CancelTokenSource[] = [];

  const fetchData = async <T = any>(
    path: string,
    {
      headers = {},
      label = 'operation',
      processResponse,
      cacheId,
      onServerSuccess,
      getStaleWhileRevalidate,
      ...options
    }: RequestOptions
  ): Promise<AxiosResponse<T>> => {
    const url = APIAdapterConfiguration.getFullResourceURL(path);

    return new Promise((resolve, reject) => {
      const requestId = String(
        hashIt({
          ...options,
          url,
        })
      );

      queueRequest(
        {
          ...options,
          url,
          resolve,
          reject,
        },
        async (resolve, reject) => {
          // Check if the request is already cached
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

          const fetchData = async (retryCount = 0): Promise<any> => {
            const cancelTokenSource = axios.CancelToken.source();
            options.getRequestController &&
              options.getRequestController({
                cancelRequest: () => {
                  cancelTokenSource.cancel(CANCELLED_API_REQUEST_MESSAGE);
                },
              });
            pendingRequestCancelTokenSources.push(cancelTokenSource);
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
                  if (RequestController.processResponseError) {
                    err = await RequestController.processResponseError(err);
                  }
                  const { response, message } = err as any;
                  const errorMessage = (() => {
                    if (response?.data) {
                      // Extracting server side error message
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
                      if (REDIRECTION_ERROR_MESSAGES.includes(message)) {
                        cancelPendingRequests();
                        return message;
                      }
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
              onServerSuccess && onServerSuccess(response);
              return resolve(response);
            }
          };
          fetchData();
        }
      );
    });
  };

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

  const get = <T = any>(path: string, options: RequestOptions = {}) => {
    return fetchData<T>(path, options);
  };

  const post = async <T = any>(
    path: string,
    { ...options }: RequestOptions = {}
  ) => {
    options.method = 'POST';
    return fetchData<T>(path, getRequestDefaultOptions(options));
  };

  const put = async <T = any>(
    path: string,
    { ...options }: RequestOptions = {}
  ) => {
    options.method = 'PUT';
    return fetchData<T>(path, getRequestDefaultOptions(options));
  };

  const patch = async <T = any>(
    path: string,
    { ...options }: RequestOptions = {}
  ) => {
    options.method = 'PATCH';
    return fetchData<T>(path, getRequestDefaultOptions(options));
  };

  const _delete = <T = any>(path: string, options: RequestOptions = {}) => {
    options.method = 'DELETE';
    return fetchData<T>(path, options);
  };

  const logout = async () => {
    StorageManager.remove(tokenStorageKey);
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
