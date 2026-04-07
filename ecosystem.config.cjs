module.exports = {
  apps: [
    {
      name: 'unifyportfolio',
      cwd: './backend',
      script: 'dist/index.js',
      env: {
        NODE_ENV: 'production',
        BACKEND_PORT: 8188, // serves both API + frontend static in production
      },
      watch: false,
      max_memory_restart: '256M',
      error_file: '../logs/error.log',
      out_file: '../logs/out.log',
      merge_logs: true,
    },
  ],
};
