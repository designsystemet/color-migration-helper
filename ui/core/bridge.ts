// UI ↔ plugin message bridge. Generic and migration-agnostic: it forwards
// operations through the {type:'run', domain, operation, args} envelope and
// routes incoming results/progress to whichever migration controller is active.

let activeController = null;

export function setActiveController(controller) {
  activeController = controller;
}

export function send(domain, operation, args) {
  parent.postMessage({ pluginMessage: { type: 'run', domain, operation, args } }, '*');
}

export function focusNode(nodeId) {
  parent.postMessage({ pluginMessage: { type: 'focus-node', nodeId } }, '*');
}

export function initBridge() {
  window.onmessage = (event) => {
    const message = event.data.pluginMessage;
    if (!message || !activeController) {
      return;
    }
    if (message.type === 'operation-progress') {
      activeController.onProgress(message.payload);
    } else if (message.type === 'operation-result') {
      activeController.onResult(message.payload);
    }
  };
}
