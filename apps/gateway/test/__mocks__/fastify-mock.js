'use strict';

// Minimal Fastify mock for unit tests — avoids network binding
function Fastify() {
  const routes = [];
  const hooks  = [];

  const app = {
    register:    async (plugin, opts) => plugin(app, opts ?? {}),
    addHook:     (name, fn) => hooks.push({ name, fn }),
    post:        (path, opts, handler) => routes.push({ method: 'POST', path, opts, handler }),
    get:         (path, opts, handler) => routes.push({ method: 'GET',  path, opts, handler }),
    delete:      (path, opts, handler) => routes.push({ method: 'DELETE', path, opts, handler }),
    listen:      async () => {},
    close:       async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    _routes: routes,
    _hooks:  hooks,
  };

  return app;
}

module.exports = Fastify;
