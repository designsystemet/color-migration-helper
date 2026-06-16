// Generic plugin shell: the migration picker (first screen), navigation between
// the picker and each migration's UI, and the shared busy overlay. Knows
// nothing migration-specific — migrations are passed in as controllers.
import { setActiveController } from './bridge';

let busyOverlayEl;
let busyTextEl;

export function setBusyOverlay(isBusy, message) {
  busyOverlayEl.classList.toggle('active', isBusy);
  if (message) {
    busyTextEl.textContent = message;
  }
}

function showPicker(picker, controllers) {
  setActiveController(null);
  picker.classList.remove('is-hidden');
  for (const controller of controllers) {
    document.getElementById(controller.rootId).classList.add('is-hidden');
  }
}

function enterMigration(controller, picker, controllers) {
  picker.classList.add('is-hidden');
  for (const other of controllers) {
    document.getElementById(other.rootId).classList.toggle('is-hidden', other !== controller);
  }
  setActiveController(controller);
  controller.enter();
}

// Each controller exposes: { id, title, description, icon, rootId, enter,
// onProgress, onResult }. The picker renders one card per controller.
export function initShell(controllers) {
  busyOverlayEl = document.getElementById('busyOverlay');
  busyTextEl = document.getElementById('busyText');

  const picker = document.getElementById('migration-picker');
  const grid = document.createElement('div');
  grid.className = 'landing';
  for (const controller of controllers) {
    const card = document.createElement('button');
    card.className = 'landing-card panel';
    card.innerHTML = `${controller.icon}<span class="landing-card-label">${controller.title}</span><p>${controller.description}</p>`;
    card.onclick = () => enterMigration(controller, picker, controllers);
    grid.appendChild(card);
  }
  picker.appendChild(grid);

  for (const el of document.querySelectorAll('[data-go-to-migrations]')) {
    el.addEventListener('click', () => showPicker(picker, controllers));
  }

  showPicker(picker, controllers);
}
