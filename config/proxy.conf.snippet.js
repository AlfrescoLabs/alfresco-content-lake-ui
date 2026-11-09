/**
 * Proxy snippet for ACA development server.
 *
 * Add the '/api/rag' and '/api/content-lake' blocks to your existing
 * `app/proxy.conf.js`.
 * Adjust the targets to where rag-service and batch-ingester are running.
 *
 */
module.exports = {

  // --- existing ACA proxy entries --------------------------------
  // '/alfresco': { target: 'http://localhost:8080', ... },

  // --- RAG service -----------------------------------------------
  '/api/rag': {
    target: 'http://localhost:9091',
    changeOrigin: true,
    secure: false,
    logLevel: 'debug',
  },

  // --- App for OpenArch status API ----------------------------------
  '/api/content-lake': {
    target: 'http://localhost:9090',
    changeOrigin: true,
    secure: false,
    logLevel: 'debug',
  }

};
