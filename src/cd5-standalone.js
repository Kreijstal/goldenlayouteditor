const { Cd5Panel } = require('./cd5-plugin');
window.cd5Panel = new Cd5Panel({element:document.getElementById('viewer'),on(){}},{workerUrl:new URL('worker.js',location.href).href});
