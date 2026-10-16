// Extraction must preserve required HTTP methods and route parameters without
// pulling router or server implementation dependencies into client declarations.
export type HttpRouteHandlers<Params, Methods extends string> = {
  [Method in Methods]: (context: {
    request: Request;
    params: Params;
  }) => Response | Promise<Response>;
};
