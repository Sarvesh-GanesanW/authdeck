/** Names whose values make programs load or run code. */
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { envLoadsCode } from '../../src/envcore';

it('flags loaders, interpreter start-up, helper programs and PATH, in any case', () => {
  const flagged = ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'PYTHONSTARTUP', 'PYTHONPATH', 'PYTHONHOME', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'PROMPT_COMMAND', 'ZDOTDIR', 'PATH', 'npm_config_script_shell', 'path', 'node_options', 'LESSOPEN', 'ELECTRON_RUN_AS_NODE'];
  for (const name of flagged) assert.equal(envLoadsCode(name), true, name);
});

it('flags build hooks, runtime hooks, other repos and TLS weakeners', () => {
  const flagged = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_AUTHOR_NAME', 'GIT_SSL_NO_VERIFY', 'GOFLAGS', 'GOPROXY', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'RUSTC_WRAPPER', 'RUSTC', 'RUSTFLAGS', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_HOME', 'DOTNET_STARTUP_HOOKS', 'CORECLR_PROFILER_PATH', 'COR_PROFILER_PATH', 'MAVEN_OPTS', 'GRADLE_OPTS', 'JAVA_OPTS', 'ERL_AFLAGS', 'ERL_ZFLAGS', 'PSMODULEPATH', 'PROMPT', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'PIP_INDEX_URL', 'KUBECONFIG', 'DOCKER_HOST', 'YARN_RC_FILENAME', 'CGO_LDFLAGS', 'HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'SSLKEYLOGFILE'];
  for (const name of flagged) assert.equal(envLoadsCode(name), true, name);
});

it('leaves ordinary variables alone', () => {
  for (const name of ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'NODE_ENV', 'PORT', 'API_PATH', 'ENVIRONMENT', 'LD_BIND_NOW_X', 'MY_PATH', 'CCACHE_DIR_X', 'REDIS_URL', 'SENTRY_DSN']) {
    assert.equal(envLoadsCode(name), false, name);
  }
});
