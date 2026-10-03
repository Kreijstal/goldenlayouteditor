// The editor shows the server's files under /server (next to the browser's own
// folders, see src/vfs.js); its HTTP requests may name them that way, so
// /server/home/me/a.txt is /home/me/a.txt here. Other paths are taken as they are.
const PREFIX = '/server';

function realPath(p) {
  if (typeof p !== 'string') return p;
  if (p === PREFIX) return '/';
  return p.startsWith(PREFIX + '/') ? p.slice(PREFIX.length) : p;
}

module.exports = { realPath, PREFIX };
