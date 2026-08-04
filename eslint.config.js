const browserGlobals = {
  Blob: 'readonly',
  URL: 'readonly',
  chrome: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  confirm: 'readonly',
  document: 'readonly',
  importScripts: 'readonly',
  extractDomain: 'readonly',
  findMostSpecificDomainRule: 'readonly',
  getDomainRoot: 'readonly',
  getShortType: 'readonly',
  isLikelyAd: 'readonly',
  isLikelySafe: 'readonly',
  isThirdParty: 'readonly',
  module: 'readonly',
  navigator: 'readonly',
  normalizeDomain: 'readonly',
  requestAnimationFrame: 'readonly',
  setTimeout: 'readonly'
};

module.exports = [
  {
    ignores: ['node_modules/**']
  },
  {
    files: ['background.js', 'sidepanel.js', 'lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: browserGlobals
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        URL: 'readonly',
        clearTimeout: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly'
      }
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        __dirname: 'readonly',
        console: 'readonly',
        process: 'readonly'
      }
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  }
];
