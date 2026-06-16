// Color migration UI controller. Owns the color flow chooser, the library
// (3-step) flow, and the sketches flow. Plugs into the shell via the controller
// contract: { id, title, description, icon, rootId, enter, onProgress, onResult }.
import { send as runOperation, focusNode } from '../../core/bridge';
import { setBusyOverlay } from '../../core/shell';

const COLOR_ICON = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="9.5" r="1.25" fill="currentColor"/><circle cx="15" cy="9.5" r="1.25" fill="currentColor"/><circle cx="9.5" cy="15" r="1.25" fill="currentColor"/></svg>';

export function createColorController() {
  // Scope lookups to this migration's root so they never pick up the picker or
  // another migration's elements.
  const root = document.getElementById('migration-color');
  const viewSections = Array.from(root.querySelectorAll('.view'));
  const targetViewButtons = Array.from(root.querySelectorAll('[data-target-view]'));
  const segmentButtons = Array.from(root.querySelectorAll('.segment'));
  const stepPanels = Array.from(root.querySelectorAll('.step'));
  const primeButton = document.getElementById('prime');
  const primeStatus = document.getElementById('primeStatus');
  const primeIcon = document.getElementById('primeIcon');
  const primeStatusText = document.getElementById('primeStatusText');
  const primeNote = document.getElementById('primeNote');
  const primeActions = document.getElementById('primeActions');
  const scanVariantsButton = document.getElementById('scanVariants');
  const applyVariantsButton = document.getElementById('applyVariants');
  const fixScopeSelect = document.getElementById('fixScope');
  const supportModeSelect = document.getElementById('supportMode');
  const scanMissingButton = document.getElementById('scanMissing');
  const applyMissingButton = document.getElementById('applyMissing');
  const variantsResultPanel = document.getElementById('variantsResultPanel');
  const variantsSummary = document.getElementById('variantsSummary');
  const variantsDetails = document.getElementById('variantsDetails');
  const instancesResultPanel = document.getElementById('instancesResultPanel');
  const instancesSummary = document.getElementById('instancesSummary');
  const instancesDetails = document.getElementById('instancesDetails');
  const libraryFixScopeSelect = document.getElementById('libraryFixScope');
  const scanLibraryButton = document.getElementById('scanLibrary');
  const applyLibraryButton = document.getElementById('applyLibrary');
  const libraryResultPanel = document.getElementById('libraryResultPanel');
  const librarySummary = document.getElementById('librarySummary');
  const libraryDetails = document.getElementById('libraryDetails');
  const librarySupportChoiceRow = document.getElementById('librarySupportChoiceRow');
  const librarySupportModeSelect = document.getElementById('librarySupportMode');
  const rebindLegacyCheckbox = document.getElementById('rebindLegacyVariables');
  let activeSummary = null;
  let activeDetails = null;
  // Carries the "Renamed N variables" line from a successful prepare run into
  // the green ready state shown after the follow-up re-check.
  let primeReadyNote = '';

  // Operations run through the shared bridge under the color domain. focusNode
  // is imported from the bridge.
  function send(operation, args) {
    runOperation('color', operation, args);
  }

  const PRIME_ICONS = {
    success: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 8.2l2 2 4-4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warning: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 2l6.2 11H1.8L8 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.4" r="0.9" fill="currentColor"/></svg>',
    error: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="4.7" r="0.9" fill="currentColor"/></svg>',
  };

  // Each prime state maps to a colored card, an icon, default copy, and
  // whether the action button is shown.
  const PRIME_STATES = {
    checking: { cls: 'status-neutral', icon: null, text: 'Checking variable state...', button: false },
    needs: { cls: 'status-warning', icon: 'warning', text: 'Rename the Main color collection to Color and remove color/main/ from variable names.', button: true },
    ready: { cls: 'status-success', icon: 'success', text: 'Variables are correct and ready to be updated with Token Studio.', button: false },
    'not-library': { cls: 'status-info', icon: 'info', text: 'This file does not appear to be a Core UI Kit library. Open the library file to run these steps.', button: false },
    error: { cls: 'status-error', icon: 'error', text: 'Could not prepare variables.', button: true },
  };

  function setPrimeState(state, message) {
    const config = PRIME_STATES[state] || PRIME_STATES.needs;
    primeStatus.className = 'status-card ' + config.cls;

    if (config.icon) {
      primeIcon.innerHTML = PRIME_ICONS[config.icon];
      primeIcon.classList.remove('is-hidden');
    } else {
      primeIcon.innerHTML = '';
      primeIcon.classList.add('is-hidden');
    }

    primeStatusText.textContent = state === 'error' && message ? message : config.text;

    if (state === 'ready' && primeReadyNote) {
      primeNote.textContent = primeReadyNote;
      primeNote.classList.remove('is-hidden');
    } else {
      primeNote.textContent = '';
      primeNote.classList.add('is-hidden');
    }
    // The note only belongs to the ready state right after a prepare run.
    primeReadyNote = '';

    primeActions.classList.toggle('is-hidden', !config.button);
  }

  function resetLibraryFlowState() {
    variantsResultPanel.classList.add('is-hidden');
    instancesResultPanel.classList.add('is-hidden');
    resetVariantButtons();
    resetMissingButtons();
    setPrimeState('checking');
    selectStep('prime');
  }

  function resetSketchesFlowState() {
    libraryResultPanel.classList.add('is-hidden');
    resetLibraryButtons();
  }

  function switchView(viewName) {
    for (const view of viewSections) {
      view.classList.toggle('view-active', view.id === `view-${viewName}`);
    }

    if (viewName === 'library') {
      resetLibraryFlowState();
      send('check-prime-status');
    } else if (viewName === 'sketches') {
      resetSketchesFlowState();
    }
  }

  function selectStep(step) {
    for (const button of segmentButtons) {
      const isActive = button.dataset.step === step;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }

    for (const panel of stepPanels) {
      panel.classList.toggle('active', panel.id === `step-${step}`);
    }
  }

  function setBusy(isBusy, message) {
    primeButton.disabled = isBusy;
    scanVariantsButton.disabled = isBusy;
    applyVariantsButton.disabled = isBusy || !applyVariantsButton.dataset.ready;
    fixScopeSelect.disabled = isBusy;
    supportModeSelect.disabled = isBusy;
    scanMissingButton.disabled = isBusy;
    applyMissingButton.disabled = isBusy || !applyMissingButton.dataset.ready;
    libraryFixScopeSelect.disabled = isBusy;
    scanLibraryButton.disabled = isBusy;
    applyLibraryButton.disabled = isBusy || !applyLibraryButton.dataset.ready;
    rebindLegacyCheckbox.disabled = isBusy;
    setBusyOverlay(isBusy, message);
  }

  function setActiveResult(panel, summary, details) {
    activeSummary = summary;
    activeDetails = details;
    panel.classList.remove('is-hidden');
  }

  function startOperation(message, panel, summary, details) {
    setActiveResult(panel, summary, details);
    setBusy(true, message);
    activeSummary.textContent = message;
    activeDetails.innerHTML = '';
  }

  function activateVariantApply(details) {
    const total = (details.removeCount || 0) + (details.renameCount || 0) + (details.colorModeMigrationCount || 0);
    applyVariantsButton.textContent = total > 0 ? `Remove and update variants (${total})` : 'Remove and update variants';
    applyVariantsButton.dataset.ready = total > 0 ? 'true' : '';
    applyVariantsButton.disabled = total === 0;
  }

  function resetVariantButtons() {
    applyVariantsButton.textContent = 'Remove and update variants';
    applyVariantsButton.dataset.ready = '';
    applyVariantsButton.disabled = true;
  }

  function activateMissingApply(details) {
    const readyCount = details.readyCount || 0;
    applyMissingButton.textContent = readyCount > 0
      ? `Update ${readyCount} instance${readyCount === 1 ? '' : 's'}`
      : 'Update instances';
    applyMissingButton.dataset.ready = readyCount > 0 ? 'true' : '';
    applyMissingButton.disabled = readyCount === 0;
  }

  function resetMissingButtons() {
    applyMissingButton.textContent = 'Update instances';
    applyMissingButton.dataset.ready = '';
    applyMissingButton.disabled = true;
  }

  function activateLibraryApply(details) {
    const ready = details.readyCount || 0;
    const review = details.reviewCount || 0;
    const total = ready + review;
    let label = 'Update instances';
    if (total > 0) {
      label = `Update ${total} instance${total === 1 ? '' : 's'}`;
      if (review > 0) {
        label += ` (${review} need${review === 1 ? 's' : ''} review)`;
      }
    }
    applyLibraryButton.textContent = label;
    applyLibraryButton.dataset.ready = total > 0 ? 'true' : '';
    applyLibraryButton.disabled = total === 0;

    const supportFallbackCount = details.supportFallbackCount || 0;
    const availableModes = Array.isArray(details.availableColorModes) ? details.availableColorModes : [];
    if (supportFallbackCount > 0 && availableModes.length > 0) {
      librarySupportModeSelect.innerHTML = '';
      for (const mode of availableModes) {
        const option = document.createElement('option');
        option.value = mode.modeId;
        option.textContent = mode.name;
        librarySupportModeSelect.appendChild(option);
      }
      librarySupportChoiceRow.classList.remove('is-hidden');
    } else {
      librarySupportChoiceRow.classList.add('is-hidden');
    }
  }

  function resetLibraryButtons() {
    applyLibraryButton.textContent = 'Update instances';
    applyLibraryButton.dataset.ready = '';
    applyLibraryButton.disabled = true;
    librarySupportChoiceRow.classList.add('is-hidden');
  }

  function renderOperationProgress(payload) {
    const progress = typeof payload.processed === 'number' && typeof payload.total === 'number'
      ? ` (${payload.processed}/${payload.total})`
      : '';
    const message = `${payload.message}${progress}`;
    if (activeSummary) {
      activeSummary.textContent = message;
    }
    busyText.textContent = message;
  }

  function renderOperationResult(payload) {
    if (payload.operation === 'load-color-modes') {
      renderColorModes(payload);
      setBusy(false);
      return;
    }

    if (payload.operation === 'check-prime-status') {
      const details = payload.details || {};
      setPrimeState(details.state || 'needs');
      setBusy(false);
      return;
    }

    if (payload.operation === 'prime-variables') {
      if (payload.status === 'error') {
        setPrimeState('error', payload.message);
        setBusy(false);
      } else {
        // Re-derive the real variable state from the file rather than assuming
        // success, and carry the count into the resulting green ready card.
        // Set the note after setPrimeState, which clears it on every call.
        const renamed = (payload.details || {}).renamedVariableCount || 0;
        setPrimeState('checking');
        primeReadyNote = `Renamed ${renamed} variable${renamed === 1 ? '' : 's'}.`;
        send('check-prime-status');
      }
      return;
    }

    setResultTargetForOperation(payload.operation);

    if (payload.operation === 'scan-unsupported-variants' && payload.status === 'preview') {
      activateVariantApply(payload.details || {});
    } else if (payload.operation === 'scan-missing-instances' && payload.status === 'preview') {
      activateMissingApply(payload.details || {});
    } else if (payload.operation === 'scan-library-stuck-instances' && payload.status === 'preview') {
      activateLibraryApply(payload.details || {});
    } else if (payload.operation === 'apply-unsupported-variants') {
      resetVariantButtons();
    } else if (payload.operation === 'apply-missing-instances') {
      resetMissingButtons();
    } else if (payload.operation === 'apply-library-stuck-instances') {
      resetLibraryButtons();
    }

    setBusy(false);
    activeSummary.textContent = getResultSummary(payload);
    renderDetails(payload);
  }

  function setResultTargetForOperation(operation) {
    if (operation === 'scan-unsupported-variants' || operation === 'apply-unsupported-variants') {
      setActiveResult(variantsResultPanel, variantsSummary, variantsDetails);
      return;
    }

    if (operation === 'scan-missing-instances' || operation === 'apply-missing-instances') {
      setActiveResult(instancesResultPanel, instancesSummary, instancesDetails);
      return;
    }

    if (operation === 'scan-library-stuck-instances' || operation === 'apply-library-stuck-instances') {
      setActiveResult(libraryResultPanel, librarySummary, libraryDetails);
    }
  }

  function renderDetails(payload) {
    if (!activeDetails) {
      return;
    }
    activeDetails.innerHTML = '';

    if (payload.operation === 'scan-unsupported-variants') {
      renderVariantsDetails(payload);
      return;
    }

    if (payload.operation === 'apply-unsupported-variants') {
      renderVariantsApplyDetails(payload);
      return;
    }

    if (payload.operation === 'scan-missing-instances') {
      renderMissingDetails(payload);
      return;
    }

    if (payload.operation === 'scan-library-stuck-instances') {
      renderLibraryDetails(payload);
    }
  }

  function renderVariantsApplyDetails(payload) {
    const details = payload.details || {};
    const failed = Array.isArray(details.failed) ? details.failed : [];
    if (failed.length === 0) {
      return;
    }

    const accordion = document.createElement('details');
    accordion.className = 'instances-accordion';
    accordion.open = true;

    const summary = document.createElement('summary');
    summary.textContent = `Failed (${failed.length})`;
    accordion.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'instance-list';

    for (const item of failed) {
      const button = document.createElement('button');
      button.className = 'instance-link';
      button.dataset.nodeId = item.id;

      const name = document.createElement('div');
      name.className = 'instance-link-name';
      name.textContent = item.name || 'Unnamed';

      const meta = document.createElement('div');
      meta.className = 'instance-link-meta';
      const actionLabel = item.action ? `${item.action}` : 'unknown';
      const reason = item.reason || 'Unknown reason';
      meta.textContent = `${actionLabel} · ${reason}`;

      button.append(name, meta);
      button.onclick = () => {
        focusNode(item.id);
      };

      list.appendChild(button);
    }

    accordion.appendChild(list);
    activeDetails.appendChild(accordion);
  }

  function renderVariantsDetails(payload) {
    const plans = payload.details && Array.isArray(payload.details.plans) ? payload.details.plans : [];
    const skipped = [];
    for (const plan of plans) {
      if (!plan || !Array.isArray(plan.skippedRenames)) continue;
      for (const item of plan.skippedRenames) {
        skipped.push({
          componentSetName: plan.componentSetName,
          pageName: plan.pageName,
          variantName: item.name,
          reason: item.reason,
        });
      }
    }

    if (skipped.length === 0) {
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'detail-meta';
    heading.textContent = `Skipped renames (${skipped.length})`;
    activeDetails.appendChild(heading);

    for (const item of skipped.slice(0, 20)) {
      const detail = document.createElement('div');
      detail.className = 'detail-item';

      const title = document.createElement('div');
      title.className = 'detail-title';
      title.textContent = item.variantName || 'Unnamed variant';

      const meta = document.createElement('div');
      meta.className = 'detail-meta';
      meta.textContent = [
        `Component set: ${item.componentSetName || 'Unknown'}`,
        `Page: ${item.pageName || 'Unknown'}`,
        `Why: ${item.reason || 'Unknown'}`,
      ].join(' | ');

      detail.append(title, meta);
      activeDetails.appendChild(detail);
    }

    if (skipped.length > 20) {
      const more = document.createElement('div');
      more.className = 'detail-meta';
      more.textContent = `${skipped.length - 20} more skipped renames not shown.`;
      activeDetails.appendChild(more);
    }
  }

  function renderMissingDetails(payload) {
    const plans = payload.details && Array.isArray(payload.details.plans) ? payload.details.plans : [];
    const blockedPlans = plans.filter((plan) => plan.status === 'blocked');
    if (blockedPlans.length === 0) {
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'detail-meta';
    heading.textContent = `Needs review (${blockedPlans.length})`;
    activeDetails.appendChild(heading);

    for (const plan of blockedPlans.slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'detail-item';

      const title = document.createElement('div');
      title.className = 'detail-title';
      title.textContent = plan.instanceName || 'Unnamed instance';

      const meta = document.createElement('div');
      meta.className = 'detail-meta';
      meta.textContent = [
        `Page: ${plan.pageName || 'Unknown'}`,
        `Parent: ${plan.parentName || 'Unknown'}`,
        `Old variant: ${plan.sourceComponentName || 'Unknown'}`,
        `Old color: ${formatOptionalValue(plan.removedColor)}`,
        `Expected variant: ${formatTargetPropertyValues(plan.targetPropertyValues)}`,
        `Possible matches: ${typeof plan.targetCandidateCount === 'number' ? plan.targetCandidateCount : 'Unknown'}`,
        `Why: ${plan.reason || 'Unknown'}`,
      ].join(' | ');

      item.append(title, meta);
      activeDetails.appendChild(item);
    }

    if (blockedPlans.length > 20) {
      const more = document.createElement('div');
      more.className = 'detail-meta';
      more.textContent = `${blockedPlans.length - 20} more instances need review but are not shown.`;
      activeDetails.appendChild(more);
    }
  }

  function renderLibraryDetails(payload) {
    const plans = payload.details && Array.isArray(payload.details.plans) ? payload.details.plans : [];

    const ready = plans.filter((plan) => plan.status === 'ready');
    if (ready.length > 0) {
      renderReadyInstancesAccordion(ready);
    }

    const flagged = plans.filter((plan) => plan.status === 'blocked' || plan.status === 'review');
    if (flagged.length === 0) {
      return;
    }

    const heading = document.createElement('div');
    heading.className = 'detail-meta';
    heading.textContent = `Needs review (${flagged.length})`;
    activeDetails.appendChild(heading);

    for (const plan of flagged.slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'detail-item';

      const title = document.createElement('div');
      title.className = 'detail-title';
      title.textContent = plan.instanceName || 'Unnamed instance';

      const meta = document.createElement('div');
      meta.className = 'detail-meta';
      meta.textContent = [
        `Status: ${plan.status}`,
        `Page: ${plan.pageName || 'Unknown'}`,
        `Parent: ${plan.parentName || 'Unknown'}`,
        `Component: ${plan.oldComponentSetName || 'Unknown'}`,
        `Old color: ${formatOptionalValue(plan.oldColorValue)}`,
        `Legacy mode: ${plan.legacyModeCollectionName ? plan.legacyModeCollectionName + ' / ' + plan.legacyModeName : 'None'}`,
        `Target mode: ${plan.targetModeName || 'Default'}`,
        `Why: ${plan.reason || 'Unknown'}`,
      ].join(' | ');

      item.append(title, meta);
      activeDetails.appendChild(item);
    }

    if (flagged.length > 20) {
      const more = document.createElement('div');
      more.className = 'detail-meta';
      more.textContent = `${flagged.length - 20} more instances need review but are not shown.`;
      activeDetails.appendChild(more);
    }
  }

  function renderReadyInstancesAccordion(readyPlans) {
    const accordion = document.createElement('details');
    accordion.className = 'instances-accordion';

    const summary = document.createElement('summary');
    summary.textContent = `Ready instances (${readyPlans.length})`;
    accordion.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'instance-list';

    for (const plan of readyPlans) {
      const button = document.createElement('button');
      button.className = 'instance-link';
      button.dataset.instanceId = plan.instanceId;

      const name = document.createElement('div');
      name.className = 'instance-link-name';
      name.textContent = plan.instanceName || 'Unnamed instance';

      const meta = document.createElement('div');
      meta.className = 'instance-link-meta';
      const oldColor = formatOptionalValue(plan.oldColorValue);
      const targetMode = plan.targetModeName || 'Default';
      meta.textContent = `${plan.pageName || 'Unknown page'} · ${plan.parentName || 'Unknown parent'} · ${oldColor} → ${targetMode}`;

      button.append(name, meta);
      button.onclick = () => {
        focusNode(plan.instanceId);
      };

      list.appendChild(button);
    }

    accordion.appendChild(list);
    activeDetails.appendChild(accordion);
  }

  function formatOptionalValue(value) {
    if (!value || value === 'unknown') {
      return 'Unknown';
    }

    return value;
  }

  function formatTargetPropertyValues(targetPropertyValues) {
    if (!targetPropertyValues) {
      return 'None';
    }

    return Object.keys(targetPropertyValues)
      .map((key) => `${key}=${targetPropertyValues[key]}`)
      .join(', ');
  }

  function renderColorModes(payload) {
    const modes = payload.details && Array.isArray(payload.details.modes) ? payload.details.modes : [];
    supportModeSelect.innerHTML = '';

    for (const mode of modes) {
      const option = document.createElement('option');
      option.value = mode.modeId;
      option.textContent = mode.name;
      supportModeSelect.appendChild(option);
    }
  }

  // Folded-in support cleanup counts, shared by the missing-instance and
  // library-stuck summaries.
  function supportLayerScanSuffix(details) {
    const cleanable = (details.supportLayerReadyCount || 0) + (details.supportLayerFallbackCount || 0);
    const reviewOnly = (details.supportLayerReviewCount || 0) - (details.supportLayerFallbackCount || 0);
    if (cleanable > 0) {
      return ` Plus ${cleanable} support layer${cleanable === 1 ? '' : 's'} to clean up${reviewOnly > 0 ? ` (${reviewOnly} need review)` : ''}.`;
    }
    if (reviewOnly > 0) {
      return ` ${reviewOnly} support layer${reviewOnly === 1 ? '' : 's'} need review.`;
    }
    return '';
  }

  function supportLayerApplySuffix(details) {
    const layers = details.supportLayerFixedCount || 0;
    if (layers === 0) {
      return '';
    }
    const bindings = details.supportBindingReboundCount || 0;
    return ` Cleaned up ${bindings} support binding${bindings === 1 ? '' : 's'} on ${layers} layer${layers === 1 ? '' : 's'}.`;
  }

  function getResultSummary(payload) {
    const details = payload.details || {};

    // On error, show the actual message instead of an operation-specific
    // summary. The per-operation summaries below only read success-shaped
    // detail fields, so an error payload would otherwise render as a
    // misleading "Scanned 0 ..." line.
    if (payload.status === 'error') {
      return payload.message || 'Something went wrong.';
    }

    if (payload.operation === 'scan-unsupported-variants') {
      const changeCount = (details.removeCount || 0) + (details.renameCount || 0) + (details.colorModeMigrationCount || 0);
      let summary = `Scanned ${details.scannedComponentSetCount || 0} component sets. Found ${changeCount} change${changeCount === 1 ? '' : 's'} to apply.`;
      const errorNames = details.errorComponentSetNames || [];
      if (errorNames.length > 0) {
        summary += ` ⚠ ${errorNames.length} component set${errorNames.length === 1 ? '' : 's'} ${errorNames.length === 1 ? 'has' : 'have'} existing errors in Figma and ${errorNames.length === 1 ? 'was' : 'were'} skipped: ${errorNames.join(', ')}. Fix the variant conflicts and rescan.`;
      }
      return summary;
    }

    if (payload.operation === 'apply-unsupported-variants') {
      const colorModeMigration = details.colorModeMigration || {};
      const failedPaintWriteCount = colorModeMigration.failedPaintWriteCount || 0;
      const appliedCount = (details.removedCount || 0) + (details.renamedCount || 0) + (colorModeMigration.migratedPaintCount || 0);
      const failedCount = (details.failedCount || 0) + failedPaintWriteCount;
      const paintWriteSuffix = failedPaintWriteCount > 0
        ? ` Could not update ${failedPaintWriteCount} color binding${failedPaintWriteCount === 1 ? '' : 's'} inside nested instances.`
        : '';
      return `Applied ${appliedCount} change${appliedCount === 1 ? '' : 's'}. ${failedCount} change${failedCount === 1 ? '' : 's'} failed.${paintWriteSuffix}`;
    }

    if (payload.operation === 'load-color-modes') {
      return `Loaded ${(details.modes || []).length} color modes.`;
    }

    if (payload.operation === 'scan-missing-instances') {
      return `Scanned ${details.scannedInstanceCount || 0} instances. ${details.readyCount || 0} can be updated, and ${details.blockedCount || 0} need review.${supportLayerScanSuffix(details)}`;
    }

    if (payload.operation === 'apply-missing-instances') {
      return `Updated ${details.fixedCount || 0} instances. Left color mode unchanged for ${details.skippedModeCount || 0}. ${details.failedCount || 0} update${details.failedCount === 1 ? '' : 's'} failed.${supportLayerApplySuffix(details)}`;
    }

    if (payload.operation === 'scan-library-stuck-instances') {
      const ready = details.readyCount || 0;
      const review = details.reviewCount || 0;
      const blocked = details.blockedCount || 0;
      const supportFallback = details.supportFallbackCount || 0;
      const supportSuffix = supportFallback > 0
        ? ` Pick a fallback color below to replace 'support'.`
        : '';
      return `Scanned ${details.scannedInstanceCount || 0} instances. ${ready} ready, ${review} need review, ${blocked} blocked.${supportLayerScanSuffix(details)}${supportSuffix}`;
    }

    if (payload.operation === 'apply-library-stuck-instances') {
      return `Updated ${details.fixedCount || 0} instance${details.fixedCount === 1 ? '' : 's'}. ${details.failedCount || 0} update${details.failedCount === 1 ? '' : 's'} failed.${supportLayerApplySuffix(details)}`;
    }

    return payload.message;
  }

  for (const button of targetViewButtons) {
    button.onclick = () => switchView(button.dataset.targetView);
  }

  for (const button of segmentButtons) {
    button.onclick = () => selectStep(button.dataset.step);
  }

  primeButton.onclick = () => {
    setBusy(true, 'Preparing variables...');
    send('prime-variables');
  };

  scanVariantsButton.onclick = () => {
    resetVariantButtons();
    startOperation('Scanning variants...', variantsResultPanel, variantsSummary, variantsDetails);
    send('scan-unsupported-variants');
  };

  applyVariantsButton.onclick = () => {
    startOperation('Removing and updating variants...', variantsResultPanel, variantsSummary, variantsDetails);
    send('apply-unsupported-variants');
  };

  scanMissingButton.onclick = () => {
    resetMissingButtons();
    startOperation('Scanning instances...', instancesResultPanel, instancesSummary, instancesDetails);
    send('scan-missing-instances', {
      scope: fixScopeSelect.value,
      supportModeId: supportModeSelect.value || null,
    });
  };

  applyMissingButton.onclick = () => {
    startOperation('Updating instances...', instancesResultPanel, instancesSummary, instancesDetails);
    send('apply-missing-instances', { supportModeId: supportModeSelect.value || null });
  };

  scanLibraryButton.onclick = () => {
    resetLibraryButtons();
    startOperation('Scanning library instances...', libraryResultPanel, librarySummary, libraryDetails);
    send('scan-library-stuck-instances', {
      scope: libraryFixScopeSelect.value,
    });
  };

  applyLibraryButton.onclick = () => {
    const supportFallbackVisible = !librarySupportChoiceRow.classList.contains('is-hidden');
    const supportFallbackModeId = supportFallbackVisible ? (librarySupportModeSelect.value || null) : null;
    startOperation('Updating library instances...', libraryResultPanel, librarySummary, libraryDetails);
    send('apply-library-stuck-instances', {
      supportFallbackModeId,
      rebindLegacyVariables: rebindLegacyCheckbox.checked,
    });
  };


  return {
    id: 'color',
    title: 'Color migration',
    description: 'Migrate color variants and modes, and clean up Support color variables.',
    icon: COLOR_ICON,
    rootId: 'migration-color',
    enter() {
      switchView('landing');
      send('load-color-modes');
    },
    onProgress: renderOperationProgress,
    onResult: renderOperationResult,
  };
}
