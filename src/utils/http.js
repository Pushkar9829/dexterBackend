// Services never see Express. A controller turns the Express request into a plain context object, calls the service,
// and writes the { status, body } it returns. A service signals an expected failure by throwing AppError.

function requestContext(req) {
  return {
    user: req.user,
    sessionId: req.sessionId,
    body: req.body,
    params: req.params,
    query: req.query,
    headers: req.headers,
    rawBody: req.rawBody,
    ip: req.ip,
    socket: req.socket,
    method: req.method,
    path: req.path,
  };
}

function handle(service) {
  return async (req, res, next) => {
    let out;
    try {
      out = await service(requestContext(req));
    } catch (err) {
      return next(err);
    }
    if (!out || !Number.isInteger(out.status) || !("body" in out)) return next(new Error("handler finished without a response: " + req.method + " " + req.path));
    res.status(out.status).json(out.body);
  };
}

module.exports = { requestContext, handle };
