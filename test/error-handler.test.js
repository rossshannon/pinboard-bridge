const { test, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = '0';
const { app, server, jsonErrorHandler } = require('../web.js');

after(() => {
  server.close();
});

const fakeRes = () => {
  const res = { headersSent: false, statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test('the JSON error handler is also the last middleware, after the routes and the 404', () => {
  const stack = app._router.stack;
  assert.equal(stack.at(-1).handle, jsonErrorHandler);
  assert.equal(stack.at(-2).handle.length, 2, 'expected the 404 handler just before it');
});

test('an error without a status becomes a JSON 500', () => {
  const res = fakeRes();
  jsonErrorHandler(new Error('store exploded'), {}, res, () => {});
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Internal server error' });
});

test('a client error keeps its status and gets the matching status text', () => {
  const res = fakeRes();
  jsonErrorHandler(Object.assign(new Error('too big'), { status: 413 }), {}, res, () => {});
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.body, { error: 'Payload Too Large' });
});

test('an error after the response has started is passed on, not answered twice', () => {
  const res = fakeRes();
  res.headersSent = true;
  const err = new Error('late');
  let passed;
  jsonErrorHandler(err, {}, res, (e) => { passed = e; });
  assert.equal(passed, err);
  assert.equal(res.body, undefined);
});
