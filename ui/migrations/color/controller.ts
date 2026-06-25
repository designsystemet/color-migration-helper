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
  const stepRun = document.getElementById('step-run');
  const primeButton = document.getElementById('prime');
  const primeStatus = document.getElementById('primeStatus');
  const primeIcon = document.getElementById('primeIcon');
  const primeStatusText = document.getElementById('primeStatusText');
  const primeNote = document.getElementById('primeNote');
  const primeActions = document.getElementById('primeActions');
  const supportModeSelect = document.getElementById('supportMode');
  const supportModeError = document.getElementById('supportModeError');
  const libraryFixScopeSelect = document.getElementById('libraryFixScope');
  const libraryScanInputPanel = document.getElementById('libraryScanInputPanel');
  const scanLibraryButton = document.getElementById('scanLibrary');
  const scanAgainButton = document.getElementById('scanAgain');
  const applyLibraryButton = document.getElementById('applyLibrary');
  const libraryResultPanel = document.getElementById('libraryResultPanel');
  const librarySummary = document.getElementById('librarySummary');
  const libraryDetails = document.getElementById('libraryDetails');
  const librarySupportChoiceRow = document.getElementById('librarySupportChoiceRow');
  const librarySupportModeSelect = document.getElementById('librarySupportMode');
  const librarySupportModeError = document.getElementById('librarySupportModeError');
  const runButton = document.getElementById('runMigration');
  const runInputPanel = document.getElementById('runInputPanel');
  const runResultPanel = document.getElementById('runResultPanel');
  const runResultTitle = document.getElementById('runResultTitle');
  const runSummary = document.getElementById('runSummary');
  const runDetails = document.getElementById('runDetails');
  const busyPhase = document.getElementById('busyPhase');
  const busyBarFill = document.getElementById('busyBarFill');
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
    'needs-tokens': { cls: 'status-info', icon: 'info', text: 'Variables now have the correct names. Export tokens from Token Studio with the updated structure to continue.', button: false },
    ready: { cls: 'status-success', icon: 'success', text: 'Variables are ready.', button: false },
    'not-library': { cls: 'status-info', icon: 'info', text: 'This file does not appear to be a Core UI Kit library. Open the library file to run these steps.', button: false },
    error: { cls: 'status-error', icon: 'error', text: 'Could not rename variables.', button: true },
  };

  function setPrimeState(state, message) {
    const config = PRIME_STATES[state] || PRIME_STATES.needs;
    const ready = state === 'ready';

    primeStatus.className = 'status-card ' + config.cls;

    if (config.icon) {
      primeIcon.innerHTML = PRIME_ICONS[config.icon];
      primeIcon.classList.remove('is-hidden');
    } else {
      primeIcon.innerHTML = '';
      primeIcon.classList.add('is-hidden');
    }

    // The needs-tokens message lists the actual missing modes, so prefer it.
    primeStatusText.textContent = (state === 'error' || state === 'needs-tokens') && message ? message : config.text;

    if (ready && primeReadyNote) {
      primeNote.textContent = primeReadyNote;
      primeNote.classList.remove('is-hidden');
    } else {
      primeNote.textContent = '';
      primeNote.classList.add('is-hidden');
    }
    // The note only belongs to the ready state right after a prepare run.
    primeReadyNote = '';

    primeActions.classList.toggle('is-hidden', !config.button);

    // Single gated screen: when ready, hide the status card and reveal the
    // migrate box (loading its support-color choices); otherwise show the
    // status card and keep the migrate box hidden.
    primeStatus.classList.toggle('is-hidden', ready);
    stepRun.classList.toggle('is-hidden', !ready);
    if (ready) {
      send('load-color-modes');
    }
  }

  function resetLibraryFlowState() {
    // Restore the run box to its pre-run look (input shown, result hidden).
    runInputPanel.classList.remove('is-hidden');
    runResultPanel.classList.add('is-hidden');
    runResultPanel.classList.remove('panel-done');
    runResultTitle.textContent = 'Result';
    setPrimeState('checking');
  }

  function resetSketchesFlowState() {
    libraryScanInputPanel.classList.remove('is-hidden');
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

  function setBusy(isBusy, message) {
    if (isBusy) {
      resetProgressIndicator();
    }
    primeButton.disabled = isBusy;
    supportModeSelect.disabled = isBusy;
    libraryFixScopeSelect.disabled = isBusy;
    scanLibraryButton.disabled = isBusy;
    scanAgainButton.disabled = isBusy;
    applyLibraryButton.disabled = isBusy || !applyLibraryButton.dataset.ready;
    runButton.disabled = isBusy;
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

  function resetProgressIndicator() {
    busyPhase.classList.add('is-hidden');
    busyPhase.textContent = '';
    busyBarFill.style.width = '0%';
  }

  function activateLibraryApply(details) {
    const ready = details.readyCount || 0;
    const review = details.reviewCount || 0;
    const total = ready + review;
    // Support instances are part of the total (they get updated), but they're
    // not manual-review items, so exclude them from the "needs review" note.
    const reviewNeedingAttention = Math.max(0, review - (details.instanceSupportFallbackCount || 0));
    let label = 'Update instances';
    if (total > 0) {
      label = `Update ${total} instance${total === 1 ? '' : 's'}`;
      if (reviewNeedingAttention > 0) {
        label += ` (${reviewNeedingAttention} need${reviewNeedingAttention === 1 ? 's' : ''} review)`;
      }
    }
    applyLibraryButton.textContent = label;
    applyLibraryButton.dataset.ready = total > 0 ? 'true' : '';
    applyLibraryButton.disabled = total === 0;

    const supportFallbackCount = details.supportFallbackCount || 0;
    const availableModes = Array.isArray(details.availableColorModes) ? details.availableColorModes : [];
    if (supportFallbackCount > 0 && availableModes.length > 0) {
      librarySupportModeSelect.innerHTML = '';
      // Start on an empty placeholder so the user has to actively pick a color.
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a color…';
      placeholder.selected = true;
      librarySupportModeSelect.appendChild(placeholder);
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
    librarySupportModeError.classList.add('is-hidden');
  }

  function renderOperationProgress(payload) {
    // Phase marker (sticky): set the bold phase line and reset the bar so the
    // next phase's item counts fill it from zero.
    if (payload.phaseLabel) {
      const prefix = payload.phaseIndex && payload.phaseTotal
        ? `${payload.phaseIndex}/${payload.phaseTotal} · `
        : '';
      busyPhase.textContent = `${prefix}${payload.phaseLabel}`;
      busyPhase.classList.remove('is-hidden');
      // New phase: empty the bar until this phase's counts arrive.
      busyBarFill.style.width = '0%';
    }

    const hasCounts = typeof payload.processed === 'number' && typeof payload.total === 'number' && payload.total > 0;
    if (hasCounts) {
      busyBarFill.style.width = `${Math.min(100, Math.round((payload.processed / payload.total) * 100))}%`;
    }

    const progress = hasCounts ? ` (${payload.processed}/${payload.total})` : '';
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
      setPrimeState(details.state || 'needs', payload.message);
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

    if (payload.operation === 'scan-library-stuck-instances') {
      // Collapse the scan box once results are in; "Scan again" brings it back.
      libraryScanInputPanel.classList.add('is-hidden');
      if (payload.status === 'preview') {
        activateLibraryApply(payload.details || {});
      }
    } else if (payload.operation === 'apply-library-stuck-instances') {
      resetLibraryButtons();
    }

    // On a successful migration, hide the input box and give the result a
    // "done" look so it's clear no further action is needed.
    if (payload.operation === 'run-migration' && payload.status === 'success') {
      runInputPanel.classList.add('is-hidden');
      runResultPanel.classList.add('panel-done');
      runResultTitle.textContent = 'Migration complete';
    }

    setBusy(false);
    activeSummary.textContent = getResultSummary(payload);
    renderDetails(payload);
  }

  function setResultTargetForOperation(operation) {
    if (operation === 'scan-library-stuck-instances' || operation === 'apply-library-stuck-instances') {
      setActiveResult(libraryResultPanel, librarySummary, libraryDetails);
      return;
    }

    if (operation === 'run-migration') {
      setActiveResult(runResultPanel, runSummary, runDetails);
    }
  }

  function renderDetails(payload) {
    if (!activeDetails) {
      return;
    }
    activeDetails.innerHTML = '';

    if (payload.operation === 'scan-library-stuck-instances') {
      renderLibraryDetails(payload);
      return;
    }

    if (payload.operation === 'run-migration') {
      renderRunDetails(payload);
    }
  }

  // The combined run only surfaces items that need manual attention; the
  // headline counts live in the summary line.
  function renderRunDetails(payload) {
    const details = payload.details || {};
    const errorComponentSets = Array.isArray(details.errorComponentSets) ? details.errorComponentSets : [];
    const failedVariants = Array.isArray(details.failedVariants) ? details.failedVariants : [];

    if (errorComponentSets.length === 0 && failedVariants.length === 0) {
      return;
    }

    if (errorComponentSets.length > 0) {
      const heading = document.createElement('div');
      heading.className = 'detail-meta';
      heading.textContent = `Component sets with existing Figma errors — skipped (${errorComponentSets.length}): ${errorComponentSets.join(', ')}. Fix the variant conflicts and run again.`;
      runDetails.appendChild(heading);
    }

    if (failedVariants.length > 0) {
      renderRunAttentionList(`Variants that could not be updated (${failedVariants.length})`, failedVariants, (item) => ({
        nodeId: item.id,
        name: item.name || 'Unnamed variant',
        meta: [item.action, item.reason].filter(Boolean).join(' · '),
      }));
    }
  }

  function renderRunAttentionList(headingText, items, mapItem) {
    const heading = document.createElement('div');
    heading.className = 'detail-meta';
    heading.textContent = headingText;
    runDetails.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'instance-list';
    for (const item of items.slice(0, 50)) {
      const row = mapItem(item);
      const button = document.createElement('button');
      button.className = 'instance-link';
      button.dataset.nodeId = row.nodeId;

      const name = document.createElement('div');
      name.className = 'instance-link-name';
      name.textContent = row.name;

      const meta = document.createElement('div');
      meta.className = 'instance-link-meta';
      meta.textContent = row.meta;

      button.append(name, meta);
      if (row.nodeId) {
        button.onclick = () => focusNode(row.nodeId);
      }
      list.appendChild(button);
    }
    runDetails.appendChild(list);

    if (items.length > 50) {
      const more = document.createElement('div');
      more.className = 'detail-meta';
      more.textContent = `${items.length - 50} more not shown.`;
      runDetails.appendChild(more);
    }
  }

  function renderLibraryDetails(payload) {
    const plans = payload.details && Array.isArray(payload.details.plans) ? payload.details.plans : [];

    // Instances using the old support color — the ones the fallback choice
    // applies to. More useful to the user than the full ready list, so we show
    // these instead.
    const support = plans.filter((plan) => plan.needsSupportModeChoice);
    if (support.length > 0) {
      renderInstanceAccordion(
        `Instances using the old support color (${support.length})`,
        support,
        (plan) => `${plan.pageName || 'Unknown page'} · ${plan.parentName || 'Unknown parent'}`,
      );
    }

    // Collapsed-to-single-component instances can't be migrated automatically —
    // surface them in their own accordion with a clear manual-update message
    // rather than the generic review list.
    const collapsed = plans.filter((plan) => plan.becameSingleComponent);
    if (collapsed.length > 0) {
      renderInstanceAccordion(
        `Instances to update manually (${collapsed.length})`,
        collapsed,
        (plan) => `${plan.pageName || 'Unknown page'} · ${plan.parentName || 'Unknown parent'} · was ${plan.oldComponentSetName || 'Unknown component'}`,
      );
    }

    // Support instances aren't problems — they migrate once the fallback color
    // is chosen above, so they're counted (summary + button) rather than listed.
    const flagged = plans.filter((plan) => (plan.status === 'blocked' || plan.status === 'review') && !plan.needsSupportModeChoice && !plan.becameSingleComponent);
    if (flagged.length > 0) {
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
  }

  // Compact, click-to-focus accordion of instances. buildMeta returns the
  // secondary line per instance, so the same layout serves the support and
  // manual-update lists.
  function renderInstanceAccordion(summaryText, plans, buildMeta) {
    const accordion = document.createElement('details');
    accordion.className = 'instances-accordion';

    const summary = document.createElement('summary');
    summary.textContent = summaryText;
    accordion.appendChild(summary);

    const list = document.createElement('div');
    list.className = 'instance-list';

    for (const plan of plans) {
      const button = document.createElement('button');
      button.className = 'instance-link';
      button.dataset.instanceId = plan.instanceId;

      const name = document.createElement('div');
      name.className = 'instance-link-name';
      name.textContent = plan.instanceName || 'Unnamed instance';

      const meta = document.createElement('div');
      meta.className = 'instance-link-meta';
      meta.textContent = buildMeta(plan);

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
    supportModeError.classList.add('is-hidden');
    supportModeSelect.innerHTML = '';

    // Start on an empty placeholder so the user has to actively pick a mode.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a color…';
    placeholder.selected = true;
    supportModeSelect.appendChild(placeholder);

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

    if (payload.operation === 'load-color-modes') {
      return `Loaded ${(details.modes || []).length} color modes.`;
    }

    if (payload.operation === 'scan-library-stuck-instances') {
      const ready = details.readyCount || 0;
      const supportInstances = details.instanceSupportFallbackCount || 0;
      // Support instances wait only on the fallback color, not on manual review,
      // so keep them out of the "need review" figure and surface their own count.
      const review = Math.max(0, (details.reviewCount || 0) - supportInstances);
      // Collapsed-to-single-component instances are counted as blocked, but get
      // their own, more actionable line instead of the generic "blocked" figure.
      const collapsed = details.becameSingleComponentCount || 0;
      const blocked = Math.max(0, (details.blockedCount || 0) - collapsed);
      const supportPart = supportInstances > 0
        ? ` ${supportInstances} use the old support color (pick a replacement below).`
        : '';
      const collapsedPart = collapsed > 0
        ? ` ${collapsed} instance${collapsed === 1 ? ' needs' : 's need'} to be updated manually (see below).`
        : '';
      return `Scanned ${details.scannedInstanceCount || 0} instances. ${ready} ready, ${review} need review, ${blocked} blocked.${supportPart}${collapsedPart}${supportLayerScanSuffix(details)}`;
    }

    if (payload.operation === 'apply-library-stuck-instances') {
      return `Updated ${details.fixedCount || 0} instance${details.fixedCount === 1 ? '' : 's'}. ${details.failedCount || 0} update${details.failedCount === 1 ? '' : 's'} failed.${supportLayerApplySuffix(details)}`;
    }

    return payload.message;
  }

  for (const button of targetViewButtons) {
    button.onclick = () => switchView(button.dataset.targetView);
  }

  primeButton.onclick = () => {
    setBusy(true, 'Renaming variables...');
    send('prime-variables');
  };

  supportModeSelect.onchange = () => {
    if (supportModeSelect.value) {
      supportModeError.classList.add('is-hidden');
    }
  };

  runButton.onclick = () => {
    // Force a deliberate choice for the support replacement color.
    if (!supportModeSelect.value) {
      supportModeError.classList.remove('is-hidden');
      supportModeSelect.focus();
      return;
    }
    supportModeError.classList.add('is-hidden');
    startOperation('Running migration...', runResultPanel, runSummary, runDetails);
    send('run-migration', { supportModeId: supportModeSelect.value });
  };

  scanLibraryButton.onclick = () => {
    resetLibraryButtons();
    startOperation('Scanning library instances...', libraryResultPanel, librarySummary, libraryDetails);
    send('scan-library-stuck-instances', {
      scope: libraryFixScopeSelect.value,
    });
  };

  scanAgainButton.onclick = () => {
    // Return to the scan box (scope editable); the result is dropped until the
    // next scan.
    resetSketchesFlowState();
  };

  librarySupportModeSelect.onchange = () => {
    if (librarySupportModeSelect.value) {
      librarySupportModeError.classList.add('is-hidden');
    }
  };

  applyLibraryButton.onclick = () => {
    const supportFallbackVisible = !librarySupportChoiceRow.classList.contains('is-hidden');
    // When a support fallback is needed, force a deliberate color choice.
    if (supportFallbackVisible && !librarySupportModeSelect.value) {
      librarySupportModeError.classList.remove('is-hidden');
      librarySupportModeSelect.focus();
      return;
    }
    librarySupportModeError.classList.add('is-hidden');
    const supportFallbackModeId = supportFallbackVisible ? (librarySupportModeSelect.value || null) : null;
    startOperation('Updating library instances...', libraryResultPanel, librarySummary, libraryDetails);
    send('apply-library-stuck-instances', {
      supportFallbackModeId,
    });
  };


  return {
    id: 'color',
    title: 'Color migration',
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
