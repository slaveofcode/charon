module.exports = {
  apps: [{
    name: 'charon',
    script: 'src/app.js',
    cwd: '/home/ubuntu/projects/charon',
    env: {
      JUPITER_API_KEY: 'jup_d9fefba2caabab4065b910464b32c86074210858b28addcb07f75ab97e05290f',
    },
    output: '/tmp/charon-out.log',
    error: '/tmp/charon-err.log',
    merge_logs: true,
  }],
};
