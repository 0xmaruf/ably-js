import HttpMethods from 'common/constants/HttpMethods';
import Rest from 'common/lib/client/rest';
import ErrorInfo from 'common/lib/types/errorinfo';
import { RequestCallback, RequestParams } from 'common/types/http';
import Platform from 'common/platform';
import Defaults from 'common/lib/util/defaults';
import * as Utils from 'common/lib/util/utils';
import { getGlobalObject } from 'common/lib/util/utils';

function isAblyError(responseBody: unknown, headers: Headers): responseBody is { error?: ErrorInfo } {
  return !!headers.get('x-ably-errorcode');
}

function getAblyError(responseBody: unknown, headers: Headers) {
  if (isAblyError(responseBody, headers)) {
    return responseBody.error && ErrorInfo.fromValues(responseBody.error);
  }
}

export default function fetchRequest(
  method: HttpMethods,
  rest: Rest | null,
  uri: string,
  headers: Record<string, string> | null,
  params: RequestParams,
  body: unknown,
  callback: RequestCallback
) {
  const fetchHeaders = new Headers(headers || {});
  const _method = method ? method.toUpperCase() : Utils.isEmptyArg(body) ? 'GET' : 'POST';

  const controller = new AbortController();

  const timeout = setTimeout(
    () => {
      controller.abort();
      callback(new ErrorInfo('Request timed out', null, 408));
    },
    rest ? rest.options.timeouts.httpRequestTimeout : Defaults.TIMEOUTS.httpRequestTimeout
  );

  getGlobalObject()
    .fetch(uri + '?' + new URLSearchParams(params || {}), {
      method: _method,
      headers: fetchHeaders,
      body: body as any,
      credentials: fetchHeaders.has('authorization') ? 'include' : 'same-origin',
    })
    .then((res) => {
      clearTimeout(timeout);
      const contentType = res.headers.get('Content-Type');
      let prom;
      if (contentType && contentType.indexOf('application/x-msgpack') > -1) {
        prom = res.arrayBuffer();
      } else if (contentType && contentType.indexOf('application/json') > -1) {
        prom = res.json();
      } else {
        prom = res.text();
      }
      prom.then((body) => {
        const packed = !!contentType && contentType.indexOf('application/x-msgpack') === -1;
        if (!res.ok) {
          const err =
            getAblyError(body, res.headers) ||
            new ErrorInfo(
              'Error response received from server: ' + res.status + ' body was: ' + Platform.Config.inspect(body),
              null,
              res.status
            );
          callback(err, body, res.headers, packed, res.status);
        } else {
          callback(null, body, res.headers, packed, res.status);
        }
      });
    })
    .catch((err) => {
      clearTimeout(timeout);
      callback(err);
    });
}
