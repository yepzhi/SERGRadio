// Defensive polyfill against browser/Android auto-translation DOM mutations breaking React
if (typeof Node === 'function' && Node.prototype) {
  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (newNode, referenceNode) {
    if (referenceNode && referenceNode.parentNode !== this) {
      if (console && console.warn) {
        console.warn('[DOM Safe] Recovered from invalid insertBefore parent mismatch', this, referenceNode);
      }
      return this.appendChild(newNode);
    }
    return originalInsertBefore.apply(this, arguments);
  };

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function (child) {
    if (child && child.parentNode !== this) {
      if (console && console.warn) {
        console.warn('[DOM Safe] Recovered from invalid removeChild parent mismatch', this, child);
      }
      return child;
    }
    return originalRemoveChild.apply(this, arguments);
  };
}

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

