module.exports = {
  apps: [
    {
      name: 'unify-backend',
      cwd: './backend',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        BACKEND_PORT: 8189,
      },
      watch: false,
      max_memory_restart: '256M',
      error_file: '../logs/backend-error.log',
      out_file: '../logs/backend-out.log',
      merge_logs: true,
    },
    {
      name: 'unify-frontend',
      script: './frontend/serve.cjs',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      max_memory_restart: '128M',
      error_file: './logs/frontend-error.log',
      out_file: './logs/frontend-out.log',
      merge_logs: true,
    },
  ],
};
