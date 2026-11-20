/**
 * Method-aware router with simple :param path segments.
 */

export function matchPath(pattern, pathname) {
  const pp = pattern.split("/").filter(Boolean);
  const sp = pathname.split("/").filter(Boolean);
  if (pp.length !== sp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
    } else if (pp[i] !== sp[i]) {
      return null;
    }
  }
  return params;
}

export function matchRoute(routes, method, pathname) {
  const pathMatched = [];
  for (const route of routes) {
    const params = matchPath(route.path, pathname);
    if (params) {
      pathMatched.push({ route, params });
      if (route.method === method) {
        return {
          route,
          params,
          allowedMethods: pathMatched.map((x) => x.route.method),
          matchedPath: true
        };
      }
    }
  }

  if (pathMatched.length > 0) {
    const methods = [...new Set(pathMatched.map((x) => x.route.method))];
    return { route: null, params: {}, allowedMethods: methods, matchedPath: true };
  }

  return { route: null, params: {}, allowedMethods: [], matchedPath: false };
}
