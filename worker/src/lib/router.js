/**
 * Minimal method-aware router for Phase 1+.
 * Handlers: (request, env, ctx) => Response | Promise<Response>
 * ctx: { requestId, corsHeaders, url, params }
 */

/**
 * @typedef {object} Route
 * @property {string} method
 * @property {string|RegExp} path
 * @property {(request: Request, env: any, ctx: any) => Response | Promise<Response>} handler
 */

/**
 * @param {Route[]} routes
 * @param {string} method
 * @param {string} pathname
 * @returns {{ route: Route|null, allowedMethods: string[], matchedPath: boolean }}
 */
export function matchRoute(routes, method, pathname) {
  const pathMatched = [];
  for (const route of routes) {
    let matches = false;
    if (typeof route.path === "string") {
      matches = route.path === pathname;
    } else if (route.path instanceof RegExp) {
      matches = route.path.test(pathname);
    }
    if (matches) {
      pathMatched.push(route);
      if (route.method === method) {
        return { route, allowedMethods: pathMatched.map((r) => r.method), matchedPath: true };
      }
    }
  }

  if (pathMatched.length > 0) {
    const methods = [...new Set(pathMatched.map((r) => r.method))];
    return { route: null, allowedMethods: methods, matchedPath: true };
  }

  return { route: null, allowedMethods: [], matchedPath: false };
}
