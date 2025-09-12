// Given a protected resource metadata url generate the url of the original
// resource
export function getResourceUrl(req: Request) {
  const url = new URL(req.url);
  url.pathname = url.pathname.replace(
    /\.well-known\/oauth-protected-resource\/?/,
    "",
  );
  return url.toString();
}

// Get given a request, generate a protected resource metadata url for the
// given resource url
export function getPRMUrl(req: Request) {
  const url = new URL(req.url);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}
