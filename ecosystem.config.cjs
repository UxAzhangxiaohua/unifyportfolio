module.exports = {
  apps: [
    {
      name: 'unifyportfolio',
      cwd: './backend',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        BACKEND_PORT: 3001,
      },
      watch: false,
      max_memory_restart: '256M',
      error_file: '../logs/error.log',
      out_file: '../logs/out.log',
      merge_logs: true,
    },
  ],
};
