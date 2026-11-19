/**
 * Variable names that make a program load or run other code, or stop checking TLS: set from a
 * team's env set, any member could run code (or read traffic) on every computer that runs the set.
 * The CLI and the phone use envLoadsCode to refuse or warn about them. Names compare in upper
 * case, since Windows treats environment names that way.
 */

/** Exact names. */
export const ENV_CODE_LOADING_NAMES: readonly string[] = [
  // Node and Electron
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'ELECTRON_RUN_AS_NODE',
  // Dynamic loaders (DYLD_* is a prefix below)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'GCONV_PATH',
  // Shell startup and hooks
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'PS4',
  'SHELLOPTS',
  'BASHOPTS',
  'ZDOTDIR',
  'HOME',
  'XDG_CONFIG_HOME',
  'SHELL',
  // Python, Perl, Ruby, Java, Lua, PHP, R, Tcl
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'PYTHONWARNINGS',
  'PYTHONBREAKPOINT',
  'PERL5OPT',
  'PERL5LIB',
  'PERLLIB',
  'PERL5DB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'LUA_INIT',
  'LUA_PATH',
  'LUA_CPATH',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
  'R_PROFILE',
  'R_PROFILE_USER',
  'TCLLIBPATH',
  // Git's helper programs (every GIT_* is also a prefix below)
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_ASKPASS',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PAGER',
  'GIT_EXTERNAL_DIFF',
  'GIT_PROXY_COMMAND',
  'GIT_TEMPLATE_DIR',
  'GIT_CONFIG',
  // Build tools: compilers, their flags, wrappers and launchers
  'CC',
  'CXX',
  'CPP',
  'LD',
  'AR',
  'CFLAGS',
  'CXXFLAGS',
  'CPPFLAGS',
  'LDFLAGS',
  'PKG_CONFIG_PATH',
  'CMAKE_C_COMPILER_LAUNCHER',
  'CMAKE_CXX_COMPILER_LAUNCHER',
  'RUSTFLAGS',
  'RUSTDOCFLAGS',
  'RUSTUP_TOOLCHAIN',
  'GOFLAGS',
  'GOPROXY',
  'GOSUMDB',
  'GONOSUMDB',
  'GONOSUMCHECK',
  'GOINSECURE',
  'GOTOOLCHAIN',
  'GOROOT',
  'GOENV',
  'MAVEN_OPTS',
  'MAVEN_ARGS',
  'GRADLE_OPTS',
  'GRADLE_USER_HOME',
  'JAVA_OPTS',
  'JAVA_HOME',
  'ANT_OPTS',
  'SBT_OPTS',
  'ERL_AFLAGS',
  'ERL_ZFLAGS',
  'ERL_FLAGS',
  'ERL_LIBS',
  'ELIXIR_ERL_OPTIONS',
  // Package managers fetching and running code from elsewhere
  'PIP_INDEX_URL',
  'PIP_EXTRA_INDEX_URL',
  'PIP_TRUSTED_HOST',
  'UV_INDEX_URL',
  'UV_EXTRA_INDEX_URL',
  'GEM_HOME',
  'GEM_PATH',
  'BUNDLE_GEMFILE',
  'PYTHONEXECUTABLE',
  // Tools whose config files can name programs to run
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'KUBECONFIG',
  'AWS_CONFIG_FILE',
  // PowerShell and cmd.exe
  'PSMODULEPATH',
  'PROMPT',
  // TLS checks turned off or other roots trusted
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'PYTHONHTTPSVERIFY',
  'DENO_CERT',
  // Traffic sent through another host, or TLS session keys written out
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'SSLKEYLOGFILE',
  // Programs other tools start
  'EDITOR',
  'VISUAL',
  'PAGER',
  'MANPAGER',
  'BROWSER',
  'LESSOPEN',
  'LESSCLOSE',
  'SSH_ASKPASS',
  'SUDO_ASKPASS',
  'MAKEFLAGS',
  // Where commands are found
  'PATH',
  'PATHEXT',
  'COMSPEC',
];

/** Prefixes: every name starting with one. */
export const ENV_CODE_LOADING_PREFIXES: readonly string[] = [
  'DYLD_',
  // Every git variable: GIT_DIR and GIT_WORK_TREE point git at another repo's hooks and config.
  'GIT_',
  'NPM_CONFIG_',
  'YARN_',
  'COREPACK_',
  'CGO_',
  'DOTNET_',
  'CORECLR_',
  'COR_',
  'CARGO_',
  'RUSTC',
];

const NAMES = new Set(ENV_CODE_LOADING_NAMES);

/** True when setting `name` can make a program load or run code it otherwise wouldn't. */
export function envLoadsCode(name: string): boolean {
  const upper = name.toUpperCase();
  return NAMES.has(upper) || ENV_CODE_LOADING_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
