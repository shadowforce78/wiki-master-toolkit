(() => {
  const registry = window.__wmAverageFeatures ||= {};

  registry.packs = {
    create(runtime) {
      const {
        PULL_RECAP_ENABLED_KEY, AUTO_OPEN_ENABLED_KEY, AUTO_OPEN_NEXT_AT_KEY,
        AUTO_OPEN_SESSION_KEY, AUTO_OPEN_MIN_MINUTES_KEY, AUTO_OPEN_MAX_MINUTES_KEY,
        AUTO_OPEN_DEFAULT_MIN_MINUTES, AUTO_OPEN_DEFAULT_MAX_MINUTES,
        ALL_COLLECTION_KEY, cacheMemory, isPullsPage, isLastPullCardVisible,
        normalizeTitle, readLocalValue, writeLocalValue, storageGet, storageSet,
        reportError, createSponsorNote
      } = runtime.core;
      const { formatAverage, chooseAverage } = runtime.priceUi;

      let pullRecapEnabled = runtime.settings.isEnabled('packRecap') && readLocalValue(PULL_RECAP_ENABLED_KEY) !== false;
      let activePackRecap = null;
      let packRecapDismissed = false;
      let openAllActive = false;
      let openAllRequestId = null;
      let openAllButton = null;
      let openAllSummaryCards = [];
      let openAllOpenedPacks = 0;
      let openAllError = null;
      let openAllRenderTimer = null;
      let openAllSummaryTitle = 'Cartes obtenues';
      let openAllSummaryOnClose = null;
      let openAllSummaryReloadOnClose = true;
      // Sélection et état des lignes du récap « Tout ouvrir », indexés par position d'origine.
      let openAllSelected = new Set();
      let openAllRowState = new Map();
      let openAllActionBusy = false;
      let openAllActionsLocked = false;
      let autoOpenEnabled = runtime.settings.isEnabled('autoOpen') && readLocalValue(AUTO_OPEN_ENABLED_KEY) === true;
      let autoOpenTimer = null;
      let autoOpenRequestId = null;
      let autoOpenShowSummaryAfterCurrent = false;
      let autoOpenToggleInput = null;
      let autoOpenToggleLabel = null;

      const acknowledgedChecks = new WeakSet();

      const uiResponseProfile = {
        responsePace: 1 + Math.random() * 1.4,
        deliberation: 0.55 + Math.random() * 1.15,
        settleDelay: 300 + Math.random() * 1500
      };

      if (!runtime.settings.isEnabled('autoOpen')) {
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
      }

      function lognormalSample(mu, sigma) {
        // Box-Muller sur loi normale, puis exponentielle => lognormale.
        let u = 0;
        let v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return Math.exp(mu + sigma * z);
      }

      function humanDelay(muMs, sigma, minMs, maxMs, multiplier = 1) {
        const raw = lognormalSample(Math.log(muMs), sigma) * multiplier;
        return Math.min(maxMs, Math.max(minMs, raw));
      }

      // Active la case de confirmation de la façon la plus naturelle possible :
      // le focus arrive juste avant l'activation (pointeur ou Tab), et la cible
      // du clic varie — une partie des utilisateurs clique sur le libellé plutôt
      // que sur la case elle-même.
      function humanActivateCheckbox(checkbox) {
        const label = checkbox.closest('label');
        const target = (label && Math.random() < 0.25) ? label : checkbox;

        if (Math.random() < 0.96) {
          try { checkbox.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }

        target.click();
      }

      // Valide le bouton après activation de la case : focus d'abord, puis une
      // dernière hésitation avant le clic final.
      function humanConfirmButton(button) {
        if (!button.isConnected || button.disabled) return;

        if (Math.random() < 0.85) {
          try { button.focus({ preventScroll: true }); } catch (_) { /* noop */ }
        }

        const deliberationMs = humanDelay(650, 0.65, 180, 4200, uiResponseProfile.deliberation);
        setTimeout(() => {
          if (button.isConnected && !button.disabled) button.click();
        }, deliberationMs);
      }

      function isElementEffectivelyVisible(element) {
        if (!element?.isConnected) return false;
        if (document.visibilityState !== 'visible') return false;

        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;

        const style = window.getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') return false;

        // Au moins partiellement dans le viewport.
        return rect.bottom > 0 && rect.right > 0 &&
          rect.top < window.innerHeight && rect.left < window.innerWidth;
      }

      // Attend qu'une condition soit vraie en sondant à intervalle irrégulier
      // pour éviter de surcharger le thread principal pendant les animations.
      function waitFor(condition, { timeoutMs = 15000, onDone } = {}) {
        const startedAt = Date.now();

        const probe = () => {
          if (condition()) {
            onDone(true);
            return;
          }

          if (Date.now() - startedAt > timeoutMs) {
            onDone(false);
            return;
          }

          setTimeout(probe, 90 + Math.random() * 160);
        };

        setTimeout(probe, 90 + Math.random() * 160);
      }

      function locatePendingConsent() {
        if (!isPullsPage()) return null;

        // Le champ "website" est un honeypot invisible : il sert uniquement
        // de repère pour retrouver le widget. Il ne doit jamais être manipulé.
        for (const honeypot of document.querySelectorAll('input[name="website"]')) {
          const hiddenLabel = honeypot.closest('label');
          const block = hiddenLabel?.parentElement;
          if (!block) continue;

          const checkbox = [...block.querySelectorAll('input[type="checkbox"]')]
            .find((input) => !input.closest('.wm-pulls-tools'));
          if (!checkbox) continue;

          const button = [...block.querySelectorAll('button')]
            .find((candidate) =>
              normalizeTitle(candidate.textContent).toLocaleLowerCase('fr') === 'continuer'
            ) || block.querySelector('button');
          if (!button) continue;

          return { block, checkbox, button };
        }

        return null;
      }

      function restoreAcknowledgedConsent() {
        if (runtime.packVerification?.isWaiting()) return;
        const verification = locatePendingConsent();
        if (!verification || acknowledgedChecks.has(verification.block)) return;

        acknowledgedChecks.add(verification.block);
        const { block, checkbox, button } = verification;

        // Séquence de restauration d'une préférence mémorisée :
        // 1. stabilisation de l'interface (bloc fraîchement monté) ~0.3 – 1.8 s
        // 2. relecture du libellé avant de cocher                  ~1.2 – 9 s (lognormal)
        // 3. restauration de l'état de la case (focus puis clic)
        // 4. délibération avant de valider                         ~0.2 – 4 s (lognormal)
        // 5. clic sur « Continuer »
        const settleMs = uiResponseProfile.settleDelay;
        const readingDelay = humanDelay(2400, 0.55, 1200, 9000, uiResponseProfile.responsePace);

        setTimeout(() => {
          // On ne restaure rien tant que le bloc n'est pas réellement visible et
          // que l'onglet n'a pas le focus (évite les interactions perdues).
          waitFor(() => isElementEffectivelyVisible(block), {
            onDone: (visible) => {
              if (!visible || !checkbox.isConnected) return;

              setTimeout(() => {
                if (!checkbox.isConnected) return;

                // Une petite distraction occasionnelle avant de confirmer —
                // notification, coup d'œil ailleurs — puis on s'y remet.
                const commit = () => {
                  if (!checkbox.isConnected || !button.isConnected) return;

                  if (!checkbox.checked) {
                    humanActivateCheckbox(checkbox);
                  }

                  // React peut laisser le bouton disabled pendant quelques ticks.
                  // On attend qu'il soit réellement cliquable avant de valider.
                  waitFor(() => (
                    checkbox.isConnected &&
                    button.isConnected &&
                    checkbox.checked &&
                    !button.disabled
                  ), {
                    timeoutMs: 5000,
                    onDone: (ready) => {
                      if (!ready) return;
                      humanConfirmButton(button);
                    }
                  });
                };

                if (Math.random() < 0.05) {
                  setTimeout(commit, humanDelay(6000, 0.6, 3000, 30000));
                } else {
                  commit();
                }
              }, readingDelay);
            }
          });
        }, settleMs);
      }

      function readAutoOpenSession() {
        const raw = readLocalValue(AUTO_OPEN_SESSION_KEY);

        return {
          startedAt: Number(raw?.startedAt) || Date.now(),
          openedPacks: Math.max(0, Number(raw?.openedPacks) || 0),
          runs: Math.max(0, Number(raw?.runs) || 0),
          cards: Array.isArray(raw?.cards) ? raw.cards.filter((card) => card?.id && card?.title) : [],
          errors: Array.isArray(raw?.errors) ? raw.errors.map(String).slice(-10) : []
        };
      }

      function writeAutoOpenSession(session) {
        writeLocalValue(AUTO_OPEN_SESSION_KEY, {
          startedAt: Number(session?.startedAt) || Date.now(),
          openedPacks: Math.max(0, Number(session?.openedPacks) || 0),
          runs: Math.max(0, Number(session?.runs) || 0),
          cards: Array.isArray(session?.cards) ? session.cards : [],
          errors: Array.isArray(session?.errors) ? session.errors.slice(-10) : []
        });
      }

      function resetAutoOpenSession() {
        const session = {
          startedAt: Date.now(),
          openedPacks: 0,
          runs: 0,
          cards: [],
          errors: []
        };
        writeAutoOpenSession(session);
        return session;
      }

      function getAutoOpenDelayBounds() {
        const normalizeMinutes = (value, fallback) => {
          const numeric = Math.round(Number(value));
          if (!Number.isFinite(numeric)) return fallback;
          return Math.max(1, Math.min(10080, numeric));
        };

        const first = normalizeMinutes(
          readLocalValue(AUTO_OPEN_MIN_MINUTES_KEY),
          AUTO_OPEN_DEFAULT_MIN_MINUTES
        );
        const second = normalizeMinutes(
          readLocalValue(AUTO_OPEN_MAX_MINUTES_KEY),
          AUTO_OPEN_DEFAULT_MAX_MINUTES
        );

        return {
          minDelay: Math.min(first, second) * 60 * 1000,
          maxDelay: Math.max(first, second) * 60 * 1000
        };
      }

      function randomAutoOpenDelay() {
        const { minDelay, maxDelay } = getAutoOpenDelayBounds();
        return Math.round(
          minDelay +
          Math.random() * (maxDelay - minDelay)
        );
      }

      function clearAutoOpenTimer() {
        if (autoOpenTimer) {
          clearTimeout(autoOpenTimer);
          autoOpenTimer = null;
        }
      }

      function updateAutoOpenToggleUi() {
        if (autoOpenToggleInput) {
          autoOpenToggleInput.checked = autoOpenEnabled;
        }
        if (autoOpenToggleLabel) {
          autoOpenToggleLabel.classList.toggle('is-enabled', autoOpenEnabled);
        }
      }

      function scheduleNextAutoOpen({ keepExisting = true } = {}) {
        clearAutoOpenTimer();

        if (!runtime.settings.isEnabled('autoOpen')) {
          autoOpenEnabled = false;
          writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
          localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
          return;
        }

        if (!autoOpenEnabled) {
          localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
          return;
        }

        let nextAt = keepExisting ? Number(readLocalValue(AUTO_OPEN_NEXT_AT_KEY)) || 0 : 0;
        const now = Date.now();

        if (nextAt <= now) {
          nextAt = now + randomAutoOpenDelay();
          writeLocalValue(AUTO_OPEN_NEXT_AT_KEY, nextAt);
        }

        const delay = Math.max(1000, nextAt - now);

        autoOpenTimer = setTimeout(() => {
          autoOpenTimer = null;
          runAutomaticOpen().catch((error) => {
            reportError('ouverture automatique', error);
            if (autoOpenEnabled) scheduleNextAutoOpen({ keepExisting: false });
          });
        }, delay);
      }

      function appendAutomaticOpenResult(detail) {
        const session = readAutoOpenSession();
        const cards = Array.isArray(detail?.cards) ? detail.cards : [];
        const openedPacks = Math.max(0, Number(detail?.openedPacks) || 0);

        if (cards.length || openedPacks > 0) {
          session.cards.push(...cards);
          session.openedPacks += openedPacks;
          session.runs += 1;
        }

        if (!detail?.ok && detail?.error) {
          session.errors.push(String(detail.error));
        }

        writeAutoOpenSession(session);
        return session;
      }

      function showAutomaticOpenSummary() {
        const session = readAutoOpenSession();

        if (!session.cards.length) {
          localStorage.removeItem(AUTO_OPEN_SESSION_KEY);
          runtime.modalUi.showInfoModal(
            'Ouverture automatique',
            'Aucune carte n’a été ouverte automatiquement pendant cette session.'
          );
          return;
        }

        const error =
          session.errors.length > 0
            ? `${session.errors.length} cycle${session.errors.length > 1 ? 's' : ''} interrompu${session.errors.length > 1 ? 's' : ''} pendant la session.`
            : null;

        openOpenAllSummary(
          session.cards,
          session.openedPacks,
          error,
          {
            title: 'Récap ouverture automatique',
            reloadOnClose: false,
            onClose: () => {
              localStorage.removeItem(AUTO_OPEN_SESSION_KEY);
            }
          }
        );
      }

      function disableAutomaticOpening({ showSummary = true } = {}) {
        autoOpenEnabled = false;
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, false);
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
        clearAutoOpenTimer();
        updateAutoOpenToggleUi();

        if (autoOpenRequestId && openAllActive && openAllRequestId === autoOpenRequestId) {
          autoOpenShowSummaryAfterCurrent = showSummary;
          return;
        }

        if (showSummary) {
          showAutomaticOpenSummary();
        }
      }

      function enableAutomaticOpening() {
        if (!runtime.settings.isEnabled('autoOpen')) return;
        autoOpenEnabled = true;
        writeLocalValue(AUTO_OPEN_ENABLED_KEY, true);
        resetAutoOpenSession();
        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);
        autoOpenShowSummaryAfterCurrent = false;
        updateAutoOpenToggleUi();
        scheduleNextAutoOpen({ keepExisting: false });
      }

      function startOpenAllPacks({ automatic = false } = {}) {
        if (openAllActive) return false;

        openAllActive = true;
        openAllSummaryCards = [];
        openAllOpenedPacks = 0;
        openAllError = null;
        openAllRequestId = `${automatic ? 'auto-packs' : 'packs'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

        if (automatic) {
          autoOpenRequestId = openAllRequestId;
        }

        if (openAllButton?.isConnected) {
          openAllButton.disabled = true;
          openAllButton.textContent = automatic ? 'Auto ouverture…' : 'Ouverture…';
        }

        document.getElementById('wm-pack-recap')?.remove();
        document.getElementById('wm-open-all-overlay')?.remove();

        window.dispatchEvent(new CustomEvent('wm-average-open-all-packs', {
          detail: { requestId: openAllRequestId }
        }));

        return true;
      }

      async function runAutomaticOpen() {
        if (!autoOpenEnabled) return;

        localStorage.removeItem(AUTO_OPEN_NEXT_AT_KEY);

        if (openAllActive) {
          scheduleNextAutoOpen({ keepExisting: false });
          return;
        }

        const started = startOpenAllPacks({ automatic: true });
        if (!started && autoOpenEnabled) {
          scheduleNextAutoOpen({ keepExisting: false });
        }
      }

      function showAutoOpenHelp() {
        runtime.modalUi.showInfoModal(
          'Ouverture automatique',
          'Quand cette option est activée, l’extension attend aléatoirement entre 20 et 100 minutes puis utilise « Tout ouvrir » pour ouvrir tous les paquets disponibles. Les récaps intermédiaires restent masqués et le cycle recommence automatiquement. Quand vous désactivez l’option, un récapitulatif cumulé de toutes les cartes ouvertes automatiquement s’affiche. Les ouvertures sont espacées et aléatoires, il n\'y a aucune différence entre avoir cela activé et mettre un réveil toutes les x minutes, les requetes au serveur sont les mêmes. WikiMasters doit rester ouvert dans au moins un onglet pour que l’automatisation puisse s’exécuter.'
        );
      }

      function ensurePullsToolbar() {
        if (!isPullsPage() || document.getElementById('wm-pulls-info')) return;

        const h1 = [...document.querySelectorAll('h1')]
          .find((el) => normalizeTitle(el.textContent) === 'Ouvrir un paquet');
        if (!h1) return;

        const header = h1.parentElement;
        if (!header) return;
        header.classList.add('wm-pulls-header');

        const tools = document.createElement('div');
        tools.id = 'wm-pulls-tools';
        tools.className = 'wm-pulls-tools';

        if (runtime.settings.isEnabled('packRecap')) {
          const label = document.createElement('label');
          label.className = 'wm-pulls-toggle';
          label.title = 'Afficher le récapitulatif des prix après chaque paquet';

          const textWrap = document.createElement('span');
          textWrap.className = 'wm-pulls-toggle-text';
          const title = document.createElement('strong');
          title.textContent = 'Récap prix';
          textWrap.append(title);

          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = pullRecapEnabled;

          const track = document.createElement('span');
          track.className = 'wm-toggle-track';
          const knob = document.createElement('span');
          knob.className = 'wm-toggle-knob';
          track.append(knob);

          input.addEventListener('change', () => {
            pullRecapEnabled = input.checked;
            writeLocalValue(PULL_RECAP_ENABLED_KEY, pullRecapEnabled);
            label.classList.toggle('is-enabled', pullRecapEnabled);

            if (pullRecapEnabled) {
              packRecapDismissed = false;
              renderPackRecap();
            } else {
              document.getElementById('wm-pack-recap')?.remove();
            }
          });

          label.classList.toggle('is-enabled', pullRecapEnabled);
          label.append(textWrap, input, track);
          tools.append(label);
        }

        if (runtime.settings.isEnabled('autoOpen')) {
          const autoControl = document.createElement('span');
          autoControl.className = 'wm-auto-open-control';

          autoOpenToggleLabel = document.createElement('label');
          autoOpenToggleLabel.className = 'wm-pulls-toggle wm-auto-open-toggle';
          autoOpenToggleLabel.title = 'Ouvrir automatiquement tous les paquets à intervalles aléatoires';

          const autoTextWrap = document.createElement('span');
          autoTextWrap.className = 'wm-pulls-toggle-text';
          const autoTitle = document.createElement('strong');
          autoTitle.textContent = 'Ouvrir automatiquement';
          autoTextWrap.append(autoTitle);

          autoOpenToggleInput = document.createElement('input');
          autoOpenToggleInput.type = 'checkbox';
          autoOpenToggleInput.checked = autoOpenEnabled;

          const autoTrack = document.createElement('span');
          autoTrack.className = 'wm-toggle-track';
          const autoKnob = document.createElement('span');
          autoKnob.className = 'wm-toggle-knob';
          autoTrack.append(autoKnob);

          autoOpenToggleInput.addEventListener('change', () => {
            if (autoOpenToggleInput.checked) enableAutomaticOpening();
            else disableAutomaticOpening({ showSummary: true });
          });

          autoOpenToggleLabel.classList.toggle('is-enabled', autoOpenEnabled);
          autoOpenToggleLabel.append(autoTextWrap, autoOpenToggleInput, autoTrack);

          const helpButton = document.createElement('button');
          helpButton.type = 'button';
          helpButton.className = 'wm-auto-open-help';
          helpButton.textContent = '?';
          helpButton.title = 'Comment fonctionne l’ouverture automatique ?';
          helpButton.setAttribute('aria-label', 'Aide ouverture automatique');
          helpButton.addEventListener('click', showAutoOpenHelp);

          autoControl.append(autoOpenToggleLabel, helpButton);
          tools.append(autoControl);
        }

        if (tools.childElementCount > 0) {
          h1.insertAdjacentElement('afterend', tools);
        }

        const info = document.createElement('div');
        info.id = 'wm-pulls-info';
        info.className = 'wm-pulls-info';

        if (runtime.settings.isEnabled('openAll')) {
          openAllButton = document.createElement('button');
          openAllButton.type = 'button';
          openAllButton.className = 'wm-tool-button wm-open-all-button';
          openAllButton.textContent = openAllActive ? 'Ouverture…' : 'Tout ouvrir';
          openAllButton.disabled = openAllActive;
          openAllButton.title = 'Ouvrir tous les paquets disponibles sans afficher les animations';
          openAllButton.addEventListener('click', () => {
            handleOpenAllPacksClick().catch((error) => reportError('tout ouvrir', error));
          });
          info.append(openAllButton);
        }

        if (
          runtime.settings.isEnabled('packRecap') ||
          runtime.settings.isEnabled('openAll') ||
          runtime.settings.isEnabled('autoOpen')
        ) {
          const cacheNote = document.createElement('div');
          cacheNote.className = 'wm-pulls-cache-note';
          cacheNote.textContent = 'Les prix moyens utilisés par les outils sont conservés dans le cache local.';
          info.append(cacheNote, createSponsorNote());
        }

        const pageSubtitle = [...header.children].find((el) => el.tagName === 'P');
        if (pageSubtitle) pageSubtitle.insertAdjacentElement('afterend', info);
        else header.append(info);
      }

      function showOpenAllConfirmation() {
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.className = 'wm-modal-overlay';

          const modal = document.createElement('div');
          modal.className = 'wm-modal wm-confirm-modal';

          const title = document.createElement('h2');
          title.textContent = 'Ouvrir tous les paquets ?';

          const text = document.createElement('p');
          text.textContent = 'Tous les paquets disponibles vont être ouverts immédiatement, sans animation. Cette action consomme les paquets.';

          const actions = document.createElement('div');
          actions.className = 'wm-modal-actions';

          const cancel = document.createElement('button');
          cancel.type = 'button';
          cancel.className = 'wm-tool-button wm-secondary-button';
          cancel.textContent = 'Annuler';

          const confirm = document.createElement('button');
          confirm.type = 'button';
          confirm.className = 'wm-tool-button';
          confirm.textContent = 'Tout ouvrir';

          const close = (value) => {
            overlay.remove();
            resolve(value);
          };

          cancel.addEventListener('click', () => close(false));
          confirm.addEventListener('click', () => close(true));
          overlay.addEventListener('click', (event) => {
            if (event.target === overlay) close(false);
          });

          actions.append(cancel, confirm);
          modal.append(title, text, actions);
          overlay.append(modal);
          document.body.append(overlay);
        });
      }

      async function handleOpenAllPacksClick() {
        if (openAllActive) return;

        const confirmed = await showOpenAllConfirmation();
        if (!confirmed) return;

        startOpenAllPacks({ automatic: false });
      }

      function setOpenAllButtonProgress(openedPacks, packsRemaining = null) {
        if (!openAllButton) return;

        if (Number.isFinite(Number(packsRemaining))) {
          openAllButton.textContent = `Ouverts ${openedPacks} • reste ${Number(packsRemaining)}`;
        } else {
          openAllButton.textContent = `Ouverts ${openedPacks}`;
        }
      }

      function setOpenAllButtonWaiting(waitMs) {
        if (!openAllButton) return;
        const seconds = Math.max(1, Math.ceil(Number(waitMs || 0) / 1000));
        openAllButton.textContent = `Attente ${seconds}s…`;
      }

      function scheduleOpenAllSummaryRender() {
        if (openAllRenderTimer) return;

        openAllRenderTimer = setTimeout(() => {
          openAllRenderTimer = null;
          renderOpenAllSummary();
        }, 100);
      }

      function renderOpenAllSummary() {
        const overlay = document.getElementById('wm-open-all-overlay');
        if (!overlay || !openAllSummaryCards.length) return;

        const list = overlay.querySelector('.wm-open-all-list');
        const subtitle = overlay.querySelector('[data-role="subtitle"]');
        const footer = overlay.querySelector('[data-role="footer"]');
        if (!list || !subtitle || !footer) return;

        const rows = openAllSummaryCards.map((card, index) => {
          const entry = cacheMemory.get(card.id);
          const loaded = Boolean(entry);
          const average = entry ? chooseAverage(entry, null, card.rarity || null) : null;
          return { ...card, _originalIndex: index, loaded, average };
        });

        rows.sort((a, b) => {
          const aPrice = Number.isFinite(a.average) ? a.average : -Infinity;
          const bPrice = Number.isFinite(b.average) ? b.average : -Infinity;
          if (bPrice !== aPrice) return bPrice - aPrice;

          if (a.loaded !== b.loaded) return a.loaded ? 1 : -1;
          return a._originalIndex - b._originalIndex;
        });

        const loadedCount = rows.filter((row) => row.loaded).length;
        const pricedRows = rows.filter((row) => Number.isFinite(row.average));
        const total = pricedRows.reduce((sum, row) => sum + row.average, 0);

        subtitle.textContent =
          `${openAllOpenedPacks} paquet${openAllOpenedPacks > 1 ? 's' : ''} • ${rows.length} cartes • ${loadedCount}/${rows.length} prix chargés`;

        list.replaceChildren();
        const fragment = document.createDocumentFragment();

        rows.forEach((row, index) => {
          const item = document.createElement('div');
          item.className = 'wm-open-all-row wm-open-all-row-selectable';

          const rowState = openAllRowState.get(row._originalIndex);
          const pick = document.createElement('input');
          pick.type = 'checkbox';
          pick.className = 'wm-open-all-pick';
          pick.setAttribute('aria-label', `Sélectionner ${row.title}`);
          pick.checked = openAllSelected.has(row._originalIndex);
          pick.disabled = openAllActionBusy || openAllActionsLocked || rowState?.done === true;
          pick.addEventListener('change', () => {
            if (pick.checked) openAllSelected.add(row._originalIndex);
            else openAllSelected.delete(row._originalIndex);
            updateOpenAllActions();
          });

          const rank = document.createElement('span');
          rank.className = 'wm-open-all-rank';
          rank.textContent = String(index + 1);

          const thumb = document.createElement('span');
          thumb.className = 'wm-open-all-thumb';
          if (row.imageUrl) {
            const img = document.createElement('img');
            img.src = row.imageUrl;
            img.alt = '';
            img.loading = 'lazy';
            thumb.append(img);
          }

          const info = document.createElement('span');
          info.className = 'wm-open-all-info';

          const name = document.createElement('strong');
          name.textContent = row.title;

          const meta = document.createElement('span');
          meta.textContent = rowState?.text ? `${row.rarity || '—'} · ${rowState.text}` : (row.rarity || '—');
          if (rowState?.done) item.classList.add('is-done');

          info.append(name, meta);

          const value = document.createElement('span');
          value.className = 'wm-open-all-price';

          if (!row.loaded) {
            value.classList.add('is-loading');
            const spinner = document.createElement('span');
            spinner.className = 'wm-average-spinner';
            value.append(spinner, document.createTextNode('…'));
          } else if (Number.isFinite(row.average)) {
            value.textContent = `${formatAverage(row.average)} W`;
          } else {
            value.textContent = '—';
            value.classList.add('is-empty');
          }

          item.append(pick, rank, thumb, info, value);
          fragment.append(item);
        });

        list.append(fragment);

        if (loadedCount < rows.length) {
          footer.textContent = 'Chargement des prix moyens…';
        } else if (!pricedRows.length) {
          footer.textContent = 'Aucune carte n’a de prix moyen';
        } else {
          footer.textContent = `Total des prix moyens connus : ${formatAverage(total)} W`;
        }

        if (openAllError) {
          const error = document.createElement('div');
          error.className = 'wm-open-all-error';
          error.textContent = openAllError;
          footer.append(document.createElement('br'), error);
        }
      }

      function openOpenAllSummary(cards, openedPacks, error = null, options = {}) {
        document.getElementById('wm-open-all-overlay')?.remove();

        openAllSummaryCards = cards;
        openAllSelected = new Set();
        openAllRowState = new Map();
        openAllActionBusy = false;
        openAllActionsLocked = false;
        openAllOpenedPacks = openedPacks;
        openAllError = error;
        openAllSummaryTitle = options.title || 'Cartes obtenues';
        openAllSummaryOnClose = typeof options.onClose === 'function' ? options.onClose : null;
        openAllSummaryReloadOnClose = options.reloadOnClose !== false;

        const overlay = document.createElement('div');
        overlay.id = 'wm-open-all-overlay';
        overlay.className = 'wm-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'wm-modal wm-open-all-modal';

        const header = document.createElement('div');
        header.className = 'wm-open-all-header';

        const headingWrap = document.createElement('div');

        const title = document.createElement('h2');
        title.textContent = openAllSummaryTitle;

        const subtitle = document.createElement('p');
        subtitle.dataset.role = 'subtitle';

        headingWrap.append(title, subtitle);

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'wm-ranking-close';
        closeButton.textContent = '×';
        closeButton.setAttribute('aria-label', 'Fermer');

        const close = () => {
          if (openAllActionBusy) return;
          overlay.remove();
          const onClose = openAllSummaryOnClose;
          const reloadOnClose = openAllSummaryReloadOnClose;

          openAllSummaryCards = [];
          openAllSelected = new Set();
          openAllRowState = new Map();
          openAllError = null;
          openAllSummaryTitle = 'Cartes obtenues';
          openAllSummaryOnClose = null;
          openAllSummaryReloadOnClose = true;

          try {
            onClose?.();
          } catch (error) {
            reportError('fermeture récap', error);
          }

          if (reloadOnClose) {
            location.reload();
          }
        };

        closeButton.addEventListener('click', close);

        header.append(headingWrap, closeButton);

        const list = document.createElement('div');
        list.className = 'wm-open-all-list';

        const footer = document.createElement('div');
        footer.className = 'wm-open-all-footer';
        footer.dataset.role = 'footer';

        modal.append(header, list, buildOpenAllActions(), footer);
        overlay.append(modal);
        document.body.append(overlay);

        renderOpenAllSummary();
        updateOpenAllActions();
      }

      const AUCTION_DURATIONS = [
        [10, '10 min'], [30, '30 min'], [60, '1 h'], [180, '3 h'],
        [360, '6 h'], [720, '12 h'], [1440, '24 h']
      ];

      function buildOpenAllActions() {
        const bar = document.createElement('div');
        bar.className = 'wm-open-all-actions';
        bar.dataset.role = 'actions';

        const selectAll = document.createElement('label');
        selectAll.className = 'wm-open-all-select-all';
        const selectAllBox = document.createElement('input');
        selectAllBox.type = 'checkbox';
        selectAllBox.dataset.role = 'select-all';
        selectAllBox.addEventListener('change', () => {
          openAllSelected = new Set();
          if (selectAllBox.checked) {
            openAllSummaryCards.forEach((_, index) => {
              if (!openAllRowState.get(index)?.done) openAllSelected.add(index);
            });
          }
          renderOpenAllSummary();
          updateOpenAllActions();
        });
        const selectAllText = document.createElement('span');
        selectAllText.dataset.role = 'selected-count';
        selectAll.append(selectAllBox, selectAllText);

        const priceField = document.createElement('label');
        priceField.className = 'wm-ranking-sale-field';
        const priceLabel = document.createElement('span');
        priceLabel.textContent = 'Prix de mise aux enchères';
        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.min = '1';
        priceInput.step = '1';
        priceInput.value = '10';
        priceInput.inputMode = 'decimal';
        priceInput.dataset.role = 'auction-price';
        priceInput.addEventListener('input', updateOpenAllActions);
        priceField.append(priceLabel, priceInput);

        const durationField = document.createElement('label');
        durationField.className = 'wm-ranking-sale-field';
        const durationLabel = document.createElement('span');
        durationLabel.textContent = 'Durée';
        const durationInput = document.createElement('select');
        durationInput.dataset.role = 'auction-duration';
        for (const [value, label] of AUCTION_DURATIONS) {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = label;
          durationInput.append(option);
        }
        durationInput.value = '10';
        durationField.append(durationLabel, durationInput);

        const buttons = document.createElement('div');
        buttons.className = 'wm-open-all-action-buttons';

        const auctionButton = document.createElement('button');
        auctionButton.type = 'button';
        auctionButton.className = 'wm-tool-button wm-primary-button';
        auctionButton.dataset.role = 'auction';
        auctionButton.addEventListener('click', () => {
          startOpenAllAuctions(Number(priceInput.value), Number(durationInput.value));
        });

        const discardButton = document.createElement('button');
        discardButton.type = 'button';
        discardButton.className = 'wm-tool-button wm-discard-danger';
        discardButton.dataset.role = 'discard';
        discardButton.addEventListener('click', startOpenAllDiscard);

        buttons.append(auctionButton, discardButton);

        const status = document.createElement('div');
        status.className = 'wm-open-all-action-status';
        status.dataset.role = 'action-status';

        bar.append(selectAll, priceField, durationField, buttons, status);
        return bar;
      }

      function updateOpenAllActions() {
        const bar = document.querySelector('#wm-open-all-overlay [data-role="actions"]');
        if (!bar) return;

        const count = openAllSelected.size;
        const selectable = openAllSummaryCards.filter((_, index) => !openAllRowState.get(index)?.done).length;
        const blocked = openAllActionBusy || openAllActionsLocked;
        const price = Number(bar.querySelector('[data-role="auction-price"]').value);

        const selectAllBox = bar.querySelector('[data-role="select-all"]');
        selectAllBox.checked = selectable > 0 && count >= selectable;
        selectAllBox.disabled = blocked || selectable === 0;
        bar.querySelector('[data-role="selected-count"]').textContent =
          count ? `${count} carte${count > 1 ? 's' : ''} sélectionnée${count > 1 ? 's' : ''}` : 'Tout sélectionner';

        const auctionButton = bar.querySelector('[data-role="auction"]');
        auctionButton.textContent = count ? `Mettre aux enchères (${count})` : 'Mettre aux enchères';
        auctionButton.disabled = blocked || !count || !Number.isFinite(price) || price <= 0;

        const discardButton = bar.querySelector('[data-role="discard"]');
        discardButton.textContent = count ? `Défausser (${count})` : 'Défausser';
        discardButton.disabled = blocked || !count;

        for (const control of bar.querySelectorAll('input[type="number"], select')) control.disabled = blocked;
      }

      function setOpenAllActionStatus(text, isError = false) {
        const node = document.querySelector('#wm-open-all-overlay [data-role="action-status"]');
        if (!node) return;
        node.textContent = text || '';
        node.classList.toggle('is-error', isError);
      }

      function setOpenAllActionBusy(value) {
        openAllActionBusy = value;
        renderOpenAllSummary();
        updateOpenAllActions();
      }

      function requestCardListing(card, baseAmount, durationMinutes) {
        return new Promise((resolve) => {
          const requestId = `pack-listing:${card.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
          const onResult = (event) => {
            if (event.detail?.requestId !== requestId) return;
            window.removeEventListener('wm-average-create-listing-result', onResult);
            resolve(event.detail);
          };
          window.addEventListener('wm-average-create-listing-result', onResult);
          // Pas d'ID d'exemplaire : le bridge choisit une copie non favorite et pas déjà en vente.
          window.dispatchEvent(new CustomEvent('wm-average-create-listing', {
            detail: {
              requestId,
              ownedCardId: null,
              catalogueCardId: card.id,
              title: card.title,
              baseAmount,
              durationMinutes,
              allowStarred: false
            }
          }));
        });
      }

      async function startOpenAllAuctions(amount, duration) {
        if (openAllActionBusy || openAllActionsLocked) return;
        const indexes = [...openAllSelected].sort((a, b) => a - b);
        if (!indexes.length || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(duration) || duration <= 0) return;

        setOpenAllActionBusy(true);
        let listed = 0;
        let skipped = 0;
        let failure = null;

        try {
          for (const [position, index] of indexes.entries()) {
            const card = openAllSummaryCards[index];
            if (!card) continue;
            setOpenAllActionStatus(`Mise aux enchères ${position + 1} / ${indexes.length}…`);

            const result = await requestCardListing(card, amount, duration);
            if (result.ok) {
              listed += 1;
              openAllRowState.set(index, { done: true, text: `En vente ${formatAverage(amount)} W` });
              openAllSelected.delete(index);
            } else if (result.needsStarredConfirmation) {
              skipped += 1;
              openAllRowState.set(index, { done: false, text: 'Seul exemplaire en favori, non vendu' });
              openAllSelected.delete(index);
            } else if (result.alreadyListed || result.notOwned) {
              skipped += 1;
              openAllRowState.set(index, { done: true, text: result.alreadyListed ? 'Déjà en vente' : 'Plus possédée' });
              openAllSelected.delete(index);
            } else {
              failure = result.error || 'erreur inconnue';
              break;
            }

            if (position < indexes.length - 1) await new Promise((resolve) => setTimeout(resolve, 700));
          }
        } finally {
          setOpenAllActionBusy(false);
        }

        const parts = [`${listed} carte${listed > 1 ? 's' : ''} mise${listed > 1 ? 's' : ''} aux enchères`];
        if (skipped) parts.push(`${skipped} ignorée${skipped > 1 ? 's' : ''}`);
        if (failure) parts.push(`arrêt : ${failure}`);
        setOpenAllActionStatus(parts.join(' · '), Boolean(failure));
      }

      async function startOpenAllDiscard() {
        if (openAllActionBusy || openAllActionsLocked) return;
        const indexes = [...openAllSelected].sort((a, b) => a - b);
        if (!indexes.length) return;

        const confirmed = await runtime.modalUi.showConfirmModal(
          `Défausser ${indexes.length} carte${indexes.length > 1 ? 's' : ''} ?`,
          'Les cartes sélectionnées seront définitivement défaussées. Les exemplaires favoris, shiny, en échange ou en vente ne sont jamais touchés.',
          { confirmLabel: 'Défausser', cancelLabel: 'Annuler' }
        );
        if (!confirmed || !openAllSelected.size) return;

        setOpenAllActionBusy(true);
        const requests = indexes
          .map((index) => ({ cardId: openAllSummaryCards[index]?.id, title: openAllSummaryCards[index]?.title }))
          .filter((entry) => entry.cardId);
        let report = null;
        let failure = null;

        try {
          report = await runtime.discard.discardPulled(requests, ({ text }) => setOpenAllActionStatus(text));
        } catch (error) {
          failure = error?.message || String(error);
        }

        if (report && report.status === 'done') {
          // Les cartes non défaussées (protégées) sont les dernières lignes de chaque carte.
          const missing = { ...report.missing };
          for (const index of [...indexes].reverse()) {
            const cardId = openAllSummaryCards[index]?.id;
            if (missing[cardId] > 0) {
              missing[cardId] -= 1;
              openAllRowState.set(index, { done: false, text: 'Protégée, non défaussée' });
            } else {
              openAllRowState.set(index, { done: true, text: 'Défaussée' });
            }
            openAllSelected.delete(index);
          }
          const text = `${report.discarded} carte${report.discarded > 1 ? 's' : ''} défaussée${report.discarded > 1 ? 's' : ''}` +
            (report.skipped ? ` · ${report.skipped} protégée${report.skipped > 1 ? 's' : ''} ignorée${report.skipped > 1 ? 's' : ''}` : '');
          setOpenAllActionBusy(false);
          setOpenAllActionStatus(text);
          return;
        }

        // Résultat incertain : on bloque les actions, le site doit être rechargé pour revérifier.
        openAllActionsLocked = true;
        setOpenAllActionBusy(false);
        setOpenAllActionStatus(
          `${failure || report?.error || 'Défausse interrompue.'} Ferme ce récap pour actualiser le site.`,
          true
        );
      }

      function mergePulledCardsIntoCollectionCache(cards) {
        const stored = storageGet(ALL_COLLECTION_KEY);
        const entry = stored[ALL_COLLECTION_KEY];
        if (!Array.isArray(entry?.cards) || !entry.cards.length) return;

        const byId = new Map(entry.cards.map((card) => [card.id, { ...card }]));
        const addedCounts = new Map();

        for (const card of cards) {
          addedCounts.set(card.id, (addedCounts.get(card.id) || 0) + 1);
          const existing = byId.get(card.id);
          if (!existing) {
            byId.set(card.id, { ...card, count: 0 });
          }
        }

        for (const [id, amount] of addedCounts) {
          const current = byId.get(id);
          current.count = (Number(current.count) || 0) + amount;
        }

        storageSet({
          [ALL_COLLECTION_KEY]: {
            ...entry,
            fetchedAt: Date.now(),
            cards: [...byId.values()]
          }
        });
      }

      function renderPackRecap() {
        const existing = document.getElementById('wm-pack-recap');

        if (
          !runtime.settings.isEnabled('packRecap') ||
          !isPullsPage() ||
          !pullRecapEnabled ||
          packRecapDismissed ||
          !activePackRecap?.cards?.length ||
          !isLastPullCardVisible()
        ) {
          existing?.remove();
          return;
        }

        const panel = existing || document.createElement('aside');
        panel.id = 'wm-pack-recap';
        panel.className = 'wm-pack-recap';
        panel.replaceChildren();

        const header = document.createElement('div');
        header.className = 'wm-pack-recap-header';

        const headingWrap = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = 'Prix moyens du paquet';

        const subtitle = document.createElement('span');
        const loaded = activePackRecap.cards.filter((card) => cacheMemory.has(card.id)).length;
        subtitle.textContent = `${loaded}/${activePackRecap.cards.length} chargées`;

        headingWrap.append(title, subtitle);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'wm-pack-recap-close';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Fermer le récap');
        close.addEventListener('click', () => {
          packRecapDismissed = true;
          panel.remove();
        });

        header.append(headingWrap, close);

        const list = document.createElement('div');
        list.className = 'wm-pack-recap-list';

        let total = 0;
        let priced = 0;

        for (const card of activePackRecap.cards) {
          const row = document.createElement('div');
          row.className = 'wm-pack-recap-row';

          const rarity = document.createElement('span');
          rarity.className = 'wm-pack-recap-rarity';
          rarity.textContent = card.rarity || '—';

          const name = document.createElement('span');
          name.className = 'wm-pack-recap-name';
          name.textContent = card.title;

          const value = document.createElement('span');
          value.className = 'wm-pack-recap-price';

          const cacheEntry = cacheMemory.get(card.id);
          if (!cacheEntry) {
            value.classList.add('is-loading');
            const spinner = document.createElement('span');
            spinner.className = 'wm-average-spinner';
            value.append(spinner, document.createTextNode('…'));
          } else {
            const average = chooseAverage(cacheEntry, null, card.rarity || null);
            if (Number.isFinite(average)) {
              total += average;
              priced += 1;
              value.textContent = `${formatAverage(average)} W`;
            } else {
              value.textContent = '—';
              value.classList.add('is-empty');
            }
          }

          row.append(rarity, name, value);
          list.append(row);
        }

        const footer = document.createElement('div');
        footer.className = 'wm-pack-recap-footer';

        if (loaded < activePackRecap.cards.length) {
          footer.textContent = 'Chargement des prix moyens…';
        } else if (priced === 0) {
          footer.textContent = 'Aucune carte n’a de prix moyen';
        } else {
          footer.textContent = `Total des prix moyens connus : ${formatAverage(total)} W`;
        }

        panel.append(header, list, footer);

        if (!existing) {
          document.body.append(panel);
        }
      }

      function handlePackOpened(cards) {
        if (!Array.isArray(cards) || !cards.length) return;

        runtime.pullStats.recordPullStats(cards);
        mergePulledCardsIntoCollectionCache(cards);

        // Cache newly obtained cards even when the recap UI is disabled.
        runtime.priceLoader.loadCacheForCards(cards);

        if (!runtime.settings.isEnabled('packRecap')) return;

        activePackRecap = {
          openedAt: Date.now(),
          cards
        };
        packRecapDismissed = false;

        try {
          renderPackRecap();
        } catch (error) {
          reportError('paquet', error);
        }
      }


      document.addEventListener('click', (event) => {
        if (!isPullsPage() || !activePackRecap) return;

        const button = event.target?.closest?.('button');
        if (!button) return;

        // Dès que l'utilisateur valide le widget de confirmation, on masque le
        // récap du paquet précédent pour laisser la place à la suite.
        if (button.parentElement?.querySelector('input[name="website"]')) {
          packRecapDismissed = true;
          document.getElementById('wm-pack-recap')?.remove();
        }
      }, true);

      window.addEventListener('wm-average-open-all-packs-progress', (event) => {
        const detail = event.detail || {};
        if (!openAllActive || detail.requestId !== openAllRequestId) return;

        openAllOpenedPacks = Number(detail.openedPacks) || 0;

        if (detail.waiting) {
          setOpenAllButtonWaiting(detail.waitMs);
          return;
        }

        setOpenAllButtonProgress(openAllOpenedPacks, detail.packsRemaining);

        const packCards = Array.isArray(detail.cards) ? detail.cards : [];
        if (!packCards.length) return;

        runtime.pullStats.recordPullStats(packCards);
        openAllSummaryCards.push(...packCards);
        mergePulledCardsIntoCollectionCache(packCards);

        const uniquePackCards = [...new Map(packCards.map((card) => [card.id, card])).values()];
        try {
          runtime.priceLoader.loadCacheForCards(uniquePackCards);
        } catch (error) {
          reportError('prix pendant tout ouvrir', error);
        }
      });
      window.addEventListener('wm-average-pack-verification-needed', event => {
        if (event.detail?.requestId === openAllRequestId && openAllButton?.isConnected) openAllButton.textContent = 'Vérification en attente…';
      });

      window.addEventListener('wm-average-open-all-packs-result', (event) => {
        const detail = event.detail || {};
        if (!openAllActive || detail.requestId !== openAllRequestId) return;

        const wasAutomatic = Boolean(autoOpenRequestId && detail.requestId === autoOpenRequestId);

        openAllActive = false;
        openAllRequestId = null;

        if (openAllButton?.isConnected) {
          openAllButton.disabled = false;
          openAllButton.textContent = 'Tout ouvrir';
        }

        const cards = Array.isArray(detail.cards) ? detail.cards : [];
        const openedPacks = Number(detail.openedPacks) || 0;

        if (wasAutomatic) {
          autoOpenRequestId = null;

          appendAutomaticOpenResult(detail);
          document.getElementById('wm-open-all-overlay')?.remove();
          document.getElementById('wm-pack-recap')?.remove();
          openAllSummaryCards = [];
          openAllError = null;

          if (autoOpenShowSummaryAfterCurrent || !autoOpenEnabled) {
            autoOpenShowSummaryAfterCurrent = false;
            showAutomaticOpenSummary();
          } else {
            scheduleNextAutoOpen({ keepExisting: false });
          }
          return;
        }

        if (!cards.length) {
          runtime.modalUi.showInfoModal(
            detail.ok ? 'Aucun paquet ouvert' : 'Ouverture impossible',
            detail.error || 'Aucun paquet disponible.'
          );
          return;
        }

        openOpenAllSummary(
          cards,
          openedPacks,
          detail.ok ? null : `Ouverture interrompue : ${detail.error || 'erreur inconnue'}`
        );
      });

      window.addEventListener('wm-average-pack-opened', (event) => {
        const cards = event.detail?.cards;
        if (!Array.isArray(cards) || !cards.length) return;
        handlePackOpened(cards);
      });


      function onPriceUpdated(id) {
        if (activePackRecap?.cards?.some((card) => card.id === id)) renderPackRecap();
        if (openAllSummaryCards.some((card) => card.id === id)) scheduleOpenAllSummaryRender();
      }

      function isAutoOpenEnabled() {
        return runtime.settings.isEnabled('autoOpen') && autoOpenEnabled;
      }

      return {
        ensurePullsToolbar, updateAutoOpenToggleUi, renderPackRecap,
        restoreAcknowledgedConsent, scheduleNextAutoOpen, onPriceUpdated,
        isAutoOpenEnabled
      };
    }
  };
})();
