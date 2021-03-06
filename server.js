// New Relic Server monitoring support
var newrelic;
if ( process.env.NEW_RELIC_ENABLED ) {
  newrelic = require( "newrelic" );
} else {
  newrelic = {
    getBrowserTimingHeader: function () {
      return "<!-- New Relic RUM disabled -->";
    }
  };
}

var configVerify = require("./lib/configverify"),
    express = require("express"),
    helmet = require("helmet"),
    Habitat = require("habitat"),
    i18n = require("webmaker-i18n"),
    lessMiddleware = require("less-middleware"),
    Makeapi = require("makeapi-client"),
    middleware = require("./lib/middleware"),
    nunjucks = require("nunjucks"),
    path = require("path"),
    routes = require("./routes"),
    slashes = require("connect-slashes");

Habitat.load();

var app = express(),
    configErrors,
    env = new Habitat(),
    makeAPIClient = new Makeapi({
      apiURL: env.get("MAKE_ENDPOINT"),
      hawk: {
        id: env.get("MAKE_PUBLIC_KEY"),
        key: env.get("MAKE_PRIVATE_KEY"),
        algorithm: "sha256"
      }
    }),
    nunjucksEnv = new nunjucks.Environment( new nunjucks.FileSystemLoader( path.join( __dirname, 'views' )), {
      autoescape: true
    }),
    oneYear = 31556952000,
    optimizeCSS = env.get("OPTIMIZE_CSS"),
    tmpDir = path.join(require("os").tmpDir(), "make-valet"),
    messina,
    logger;

nunjucksEnv.addFilter("instantiate", function(input) {
    var tmpl = new nunjucks.Template(input);
    return tmpl.render(this.getVariables());
});

configErrors = configVerify(env.all());
if (configErrors.length) {
  console.log("You need to fix the following configuration errors:");
  configErrors.forEach(function(error) {
    console.log("* %s", error);
  });
  console.log("Look at the README or env.dist for configuration options");
  process.exit(1);
  return;
}

app.disable("x-powered-by");
app.enable("trust proxy");
// Output "foo" as a subdomain when hostname is "foo.localhost"
// https://github.com/visionmedia/express/pull/1475
app.set("subdomain offset", 1);
app.locals({
  GA_ACCOUNT: env.get("GA_ACCOUNT"),
  GA_DOMAIN: env.get("GA_DOMAIN"),
  newrelic: newrelic,
  WEBMAKERORG: env.get("WEBMAKERORG")
});
nunjucksEnv.express( app );

app.use(express.favicon("public/static/images/favicon.ico", {
  maxAge: oneYear
}));

if ( env.get( "ENABLE_GELF_LOGS" ) ) {
  messina = require( "messina" );
  logger = messina( "make-valet-" + env.get( "NODE_ENV" ) || "development" );
  logger.init();
  app.use(logger.middleware());
} else {
  app.use(express.logger());
}

app.use(helmet.xssFilter());
app.use(helmet.noSniff());

app.use(express.compress());
// Redirect paths with trailing slashes to paths w/o trailing slashes
app.use(slashes(false));
app.use(lessMiddleware(path.join(__dirname, "public"), {
  once: optimizeCSS,
  dest: tmpDir,
  compress: optimizeCSS,
  yuicompress: optimizeCSS,
  optimization: optimizeCSS ? 0 : 2
}));
app.use(express.static(tmpDir, {
  maxAge: oneYear
}));
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: oneYear
}));
app.use("/static/bower", express.static(path.join(__dirname, "bower_components"), {
  maxAge: oneYear
}));

// List of supported languages - Add them in the .env file
var supportedLanguages = env.get( "SUPPORTED_LANGS" );

// Setup locales with i18n
app.use( i18n.middleware({
  supported_languages: supportedLanguages,
  default_lang: "en-US",
  mappings: require("webmaker-locale-mapping"),
  translation_directory: path.resolve( __dirname, "locale" )
}));

app.use(middleware.setVanityURL);
app.use(app.router);
app.use(middleware.errorHandler);
app.use(middleware.fourOhFourHandler);

app.get(
  "/healthcheck",
  routes.healthCheck
);

app.get(
  "/",
  middleware.setUsername,
  routes.webmakerProfile2Redirect(env.get("PROFILE_URL"))
);

app.get(
  "/dynamic/js/googleanalytics.js",
  routes.analytics
);

app.get(
  /.*_$/,
  middleware.setUsername,
  middleware.proxyPathPrepare(env.get("STATIC_DATA_STORE")),
  middleware.addCORS(env.get("ALLOW_ORIGINS")),
  routes.proxyHandler
);

app.get(
  /.*\/(remix|edit)$/,
  middleware.makeRedirect(makeAPIClient),
  middleware.setUsername,
  middleware.proxyPathPrepare(env.get("STATIC_DATA_STORE")),
  routes.proxyHandler
);

app.get(
  /.*[^_]$/,
  middleware.loadMakeDetails(makeAPIClient),
  middleware.addCSP({
    detailsHost: env.get("WEBMAKERORG"),
    reportToHost: env.get("CSP_LOGGER")
  }),
  routes.embedShellHandler,
  middleware.removeCSP,
  middleware.setUsername,
  middleware.proxyPathPrepare(env.get("STATIC_DATA_STORE")),
  routes.proxyHandler
);

app.listen(env.get("PORT"), function() {
  console.log("make-valet now listening on http://localhost:%d", env.get("PORT"));
});
