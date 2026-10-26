(() => {
  const registry = window.__wmAverageFeatures ||= {};
  registry.discard = {
    create(runtime, options = {}) {
      const model = globalThis.WMDiscardModel, core = runtime.core;
      const fetcher = options.fetch || window.__wmAverageBridgeRuntime?.core.originalFetch || window.fetch.bind(window);
      const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const PAGE_SIZE = 50, BATCH_SIZE = 50, REPORT_KEY = 'wm_discard_report_v1';
      let active = false, cancelled = false, snapshot = null, dialog = null;
      const getPrice = id => {
        if (runtime.priceLoader?.isPending?.(id) || runtime.priceLoader?.getStatus?.(id)
          || core.readLocalValue('wm_atlas_unpriced_cards_v1')?.[id]) return null;
        const stored = core.readLocalValue(core.cacheKey(id)), memory = core.cacheMemory.get(id);
        if (stored?.ok === false && (!memory || stored.fetchedAt >= memory.fetchedAt)) return stored;
        if (stored?.ok === true && (!memory || memory.ok !== true || stored.fetchedAt >= memory.fetchedAt)) return stored;
        return memory?.ok === true ? memory : stored;
      };
      function cachedPlan(maximum, rarities = model.DEFAULT_RARITIES) {
        if (active) throw Error('Une opération est déjà en cours.');
        const saved = core.readLocalValue(core.ALL_COLLECTION_KEY || 'wm_all_collection_v1');
        const cards = new Map();
        const observed = [...(core.cardMetaById?.values() || [])].filter(meta => meta.ownedCardId || meta.ownedCardIds?.length);
        for (const meta of [...(Array.isArray(saved?.cards) ? saved.cards : []), ...observed]) {
          if (!model.UUID.test(meta?.id) || !model.RARITIES.includes(meta.rarity)) continue;
          const previous = cards.get(meta.id);
          const ids = [...new Set([...(previous?.ownedCardIds || []), ...(meta.ownedCardIds || []), meta.ownedCardId].filter(Boolean))];
          const copies = [...new Map([...(previous?.ownedCopies || []), ...(meta.ownedCopies || [])].map(copy => [copy.id, copy])).values()];
          cards.set(meta.id, { ...previous, ...meta, ownedCardIds: ids, ownedCopies: copies,
            imageUrl: meta.imageUrl || previous?.imageUrl || null,
            starred: Boolean(previous?.starred || meta.starred), count: Math.max(previous?.count || 0, meta.count || 0, ids.length) });
        }
        const entries = [], seen = new Set(); let incompleteCopies = 0;
        for (const meta of cards.values()) {
          incompleteCopies += Math.max(0, meta.count - meta.ownedCardIds.length);
          const copies = new Map(meta.ownedCopies.map(copy => [copy.id, copy]));
          for (const id of meta.ownedCardIds) {
            if (!model.UUID.test(id) || seen.has(id)) throw Error('Identifiants du cache incomplets ou répétés. Charge la collection complète.');
            seen.add(id);
            const copy = copies.get(id);
            entries.push({ ownedId: id, cardId: meta.id, title: String(meta.title || meta.id), rarity: meta.rarity, imageUrl: meta.imageUrl || null,
              starred: typeof copy?.starred === 'boolean' ? copy.starred : meta.starred,
              shiny: typeof copy?.shiny === 'boolean' ? copy.shiny : Boolean(meta.shiny || meta.is_shiny) });
          }
        }
        // Older caches lack per-copy shiny/trade/sale fields. They remain usable
        // for preview; execute ALWAYS checks the real ownership/protections first.
        const protections = model.protection(saved?.protections?.tradeIds || [], (saved?.protections?.saleIds || []).map(card_id => ({ card_id })));
        snapshot = { entries, protections, scannedAt: saved?.fetchedAt || 0, cached: true,
          complete: saved?.complete === true && !incompleteCopies && (saved.total == null || saved.total === entries.length) };
        return currentPlan(maximum, rarities);
      }
      function checkStop() { if (cancelled) throw Error('Opération arrêtée.'); }
      function checkPause() {
        const pause = core.readLocalValue('wm_atlas_price_pause_v1');
        if (pause?.until > Date.now()) throw Error(`Pause serveur en cours (${Math.ceil((pause.until - Date.now()) / 1000)} s). Réessaie ensuite.`);
      }
      async function request(url, options = {}) {
        checkStop(); checkPause();
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetcher(url, { credentials: 'include', cache: 'no-store', ...options, signal: controller.signal });
          let data;
          try { data = await response.json(); } catch { throw Error('Réponse serveur illisible.'); }
          if (!response.ok) {
            const retry = response.headers?.get('Retry-After');
            const delay = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
            if ([401, 403, 429].includes(response.status)) {
              core.writeLocalValue('wm_atlas_price_pause_v1', { until: Date.now() + Math.max(120000, delay || 0), label: `HTTP ${response.status}` });
            }
            throw Error(`HTTP ${response.status}${typeof data?.error === 'string' ? ' : ' + data.error : ''}`);
          }
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Réponse serveur invalide.');
          return data;
        } finally { clearTimeout(timer); }
      }
      async function readCollection(onProgress = () => {}) {
        const first = await request('/api/my-collection?sort=rarity&page=0&stats=1');
        if (!Array.isArray(first.collection) || !Number.isSafeInteger(first.total) || first.total < 0) throw Error('Collection incomplète.');
        const pages = Math.ceil(first.total / PAGE_SIZE);
        if (pages > 10000) throw Error('Collection trop volumineuse pour une seule analyse.');
        let raw = [...first.collection]; onProgress(`Collection : ${raw.length} / ${first.total} exemplaires`);
        for (let page = 1; page < pages; page++) {
          const data = await request(`/api/my-collection?sort=rarity&page=${page}&stats=0`);
          if (!Array.isArray(data.collection) || (data.total != null && data.total !== first.total)) throw Error('La collection a changé pendant l’analyse. Réessaie.');
          raw.push(...data.collection); onProgress(`Collection : ${raw.length} / ${first.total} exemplaires`);
        }
        checkStop();
        const entries = raw.map(model.entry);
        if (entries.length !== first.total || new Set(entries.map(row => row.ownedId)).size !== first.total) throw Error('Une page manque ou la collection a changé. Aucun discard autorisé.');
        onProgress('Vérification des échanges et enchères…');
        const mine = await request('/api/marketplace?page=1&limit=50&sort=recent&mine=1');
        const protections = model.protection(first.pendingTradeCardIds, mine.selling);
        return { entries, raw, protections, scannedAt: Date.now() };
      }
      async function analyse(maximum, onProgress, rarities = model.DEFAULT_RARITIES) {
        if (active) throw Error('Une opération est déjà en cours.');
        active = true; cancelled = false; snapshot = null;
        try {
          maximum = model.threshold(maximum);
          const next = await readCollection(onProgress);
          snapshot = next;
          updateOwnership([], true);
          return currentPlan(maximum, rarities);
        } finally { active = false; }
      }
      function currentPlan(maximum, rarities = model.DEFAULT_RARITIES) {
        if (!snapshot) throw Error('Ouvre Discard pour préparer la sélection.');
        const prices = new Map();
        const cachedPrice = id => { if (!prices.has(id)) prices.set(id, getPrice(id)); return prices.get(id); };
        return { ...model.plan(snapshot.entries, cachedPrice, maximum, snapshot.protections, rarities),
          cached: Boolean(snapshot.cached), complete: snapshot.complete !== false, scannedAt: snapshot.scannedAt };
      }
      function saveReport(report) { core.writeLocalValue(REPORT_KEY, report); }
      function updateOwnership(batch, confirmed) {
        if (!snapshot?.raw) return;
        const ids = new Set(batch.map(row => row.ownedId)), affected = new Set(batch.map(row => row.cardId));
        if (confirmed) {
          snapshot.raw = snapshot.raw.filter(raw => !ids.has(raw.id));
          snapshot.entries = snapshot.entries.filter(row => !ids.has(row.ownedId));
        }
        const raw = snapshot.raw.filter(row => confirmed || !affected.has(row.card_id));
        const grouped = new Map();
        for (const row of raw) {
          const meta = window.__wmAverageBridgeRuntime?.core.mapEntry?.(row) || {
            id: row.card_id, title: row.card.wikipedia_title || row.card_id, rarity: row.card.rarity,
            imageUrl: row.card.image_url || null, wikipediaUrl: row.card.wikipedia_url || null,
            ownedCardId: row.id, ownedCardIds: [row.id], count: 1, starred: row.starred, tags: row.tags || []
          };
          const old = grouped.get(meta.id);
          if (old) {
            old.ownedCardIds.push(row.id); old.count++; old.starred ||= row.starred;
            old.ownedCopies.push({ id: row.id, starred: row.starred, shiny: row.is_shiny });
            if (core.mergeTags) old.tags = core.mergeTags(old.tags, meta.tags);
          } else grouped.set(meta.id, { ...meta, ownedCardIds: [row.id], ownedCopies: [{ id: row.id, starred: row.starred, shiny: row.is_shiny }] });
        }
        for (const [id, meta] of core.cardMetaById || []) {
          if ((meta.ownedCardId || meta.ownedCardIds?.length) && !grouped.has(id)) {
            core.cardMetaById.delete(id);
            const title = core.normalizeTitle?.(meta.title) || meta.title;
            if (core.idByTitle?.get(title) === id) core.idByTitle.delete(title);
          }
        }
        core.registerCards?.([...grouped.values()]);
        core.writeLocalValue(core.ALL_COLLECTION_KEY || 'wm_all_collection_v1', {
          cards: [...grouped.values()], total: raw.length, complete: confirmed, fetchedAt: Date.now(),
          protections: { tradeIds: [...snapshot.protections.tradeIds], saleIds: [...snapshot.protections.saleIds] }
        });
      }
      async function execute(approved, maximum, onProgress = () => {}, rarities = model.DEFAULT_RARITIES) {
        if (active) throw Error('Une opération est déjà en cours.');
        // Only rows in the completed preview can ever become approved copy IDs.
        const chosenRarities = model.rarities(rarities);
        const initial = model.verifyApproved(approved, currentPlan(maximum, chosenRarities));
        active = true; cancelled = false;
        const report = { at: Date.now(), maximum: model.threshold(maximum), rarities: chosenRarities, selected: initial.length, discarded: 0, batches: [], status: 'verifying' };
        const run = async () => {
          try {
            onProgress({ text: 'Vérification finale de la collection…', report });
            const fresh = await readCollection(text => onProgress({ text, report }));
            snapshot = fresh;
            updateOwnership([], true);
            const fixed = model.verifyApproved(initial, currentPlan(maximum, chosenRarities));
            for (let offset = 0; offset < fixed.length; offset += BATCH_SIZE) {
              checkStop(); checkPause();
              const batch = fixed.slice(offset, offset + BATCH_SIZE);
              // A synchronized/newly fetched higher price must stop remaining work.
              model.verifyApproved(batch, currentPlan(maximum, chosenRarities));
              const attempt = { ids: batch.map(row => row.ownedId), status: 'pending' };
              report.batches.push(attempt); report.status = 'running'; saveReport(report);
              onProgress({ text: `Défausse : ${report.discarded} / ${fixed.length} · lot de ${batch.length}`, report });
              let data;
              try {
                data = await request('/api/user-cards/bulk-discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_ids: attempt.ids }) });
                if (!Number.isSafeInteger(data.discarded_count) || data.discarded_count < 0 || data.discarded_count > batch.length
                  || (data.failed != null && !Array.isArray(data.failed))) throw Error('Résultat de défausse incomplet.');
              } catch (error) {
                attempt.status = 'unconfirmed';
                updateOwnership(batch, false);
                throw Error(`${error.message} Le résultat de ce lot est à vérifier sur le site ; aucun nouvel essai automatique.`);
              }
              attempt.discarded = data.discarded_count;
              attempt.failed = data.failed || [];
              report.discarded += data.discarded_count;
              attempt.status = data.discarded_count === batch.length && !attempt.failed.length ? 'done' : 'partial';
              updateOwnership(batch, attempt.status === 'done');
              saveReport(report);
              if (attempt.status === 'partial') throw Error(`${data.discarded_count} / ${batch.length} exemplaires défaussés dans le dernier lot. Arrêt pour vérifier les refus du serveur.`);
              if (offset + BATCH_SIZE < fixed.length) await wait(500);
            }
            report.status = 'done';
          } catch (error) {
            report.status = cancelled ? 'stopped' : 'error'; report.error = error.message;
          } finally {
            snapshot = null; saveReport(report);
            onProgress({ text: report.status === 'done' ? `${report.discarded} exemplaire(s) défaussé(s).` : `${report.discarded} défaussé(s). ${report.error}`, report });
          }
          return report;
        };
        try { return await runLocked(run); }
        finally { active = false; }
      }
      async function runLocked(run) {
        if (!navigator.locks?.request) return run();
        return navigator.locks.request('wm-discard-operation', { ifAvailable: true }, async lock => {
          if (!lock) throw Error('Une défausse est déjà en cours dans un autre onglet.');
          return run();
        });
      }
      // Discards pulled cards the user picked by hand (pack summary). Pack responses only know
      // catalogue IDs, so copies are resolved here from a fresh full collection read. Favorites,
      // shiny copies and anything in a pending trade or sale are never picked.
      async function discardPulled(requests, onProgress = () => {}) {
        if (active) throw Error('Une opération est déjà en cours.');
        const wanted = new Map();
        for (const request of Array.isArray(requests) ? requests : []) {
          if (!model.UUID.test(request?.cardId)) throw Error('Carte invalide.');
          wanted.set(request.cardId, (wanted.get(request.cardId) || 0) + 1);
        }
        if (!wanted.size) throw Error('Aucune carte sélectionnée.');
        active = true; cancelled = false;
        const report = { at: Date.now(), source: 'pack-summary', selected: 0, discarded: 0, skipped: 0, batches: [], status: 'verifying' };
        const missing = {};
        const run = async () => {
          try {
            onProgress({ text: 'Vérification de la collection…', report });
            const fresh = await readCollection(text => onProgress({ text, report }));
            snapshot = fresh;
            updateOwnership([], true);
            const { tradeIds, saleIds } = fresh.protections;
            const chosen = [];
            for (const [cardId, count] of wanted) {
              const copies = fresh.entries.filter(row => row.cardId === cardId && !row.starred && !row.shiny
                && !tradeIds.has(cardId) && !tradeIds.has(row.ownedId) && !saleIds.has(cardId));
              chosen.push(...copies.slice(0, count));
              const short = Math.max(0, count - copies.length);
              if (short) missing[cardId] = short;
              report.skipped += short;
            }
            report.selected = chosen.length;
            for (let offset = 0; offset < chosen.length; offset += BATCH_SIZE) {
              checkStop(); checkPause();
              const batch = chosen.slice(offset, offset + BATCH_SIZE);
              const attempt = { ids: batch.map(row => row.ownedId), status: 'pending' };
              report.batches.push(attempt); report.status = 'running'; saveReport(report);
              onProgress({ text: `Défausse : ${report.discarded} / ${chosen.length}`, report });
              let data;
              try {
                data = await request('/api/user-cards/bulk-discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_ids: attempt.ids }) });
                if (!Number.isSafeInteger(data.discarded_count) || data.discarded_count < 0 || data.discarded_count > batch.length
                  || (data.failed != null && !Array.isArray(data.failed))) throw Error('Résultat de défausse incomplet.');
              } catch (error) {
                attempt.status = 'unconfirmed';
                updateOwnership(batch, false);
                throw Error(`${error.message} Le résultat de ce lot est à vérifier sur le site ; aucun nouvel essai automatique.`);
              }
              attempt.discarded = data.discarded_count;
              attempt.failed = data.failed || [];
              report.discarded += data.discarded_count;
              attempt.status = data.discarded_count === batch.length && !attempt.failed.length ? 'done' : 'partial';
              updateOwnership(batch, attempt.status === 'done');
              saveReport(report);
              if (attempt.status === 'partial') throw Error(`${data.discarded_count} / ${batch.length} exemplaires défaussés dans le dernier lot. Arrêt pour vérifier les refus du serveur.`);
              if (offset + BATCH_SIZE < chosen.length) await wait(500);
            }
            report.status = 'done';
          } catch (error) {
            report.status = cancelled ? 'stopped' : 'error'; report.error = error.message;
          } finally {
            snapshot = null; saveReport(report);
          }
          return { ...report, missing };
        };
        try { return await runLocked(run); }
        finally { active = false; }
      }
      function stop() { cancelled = true; }
      function ensureButton() {
        if (!core.isCollectionPage()) return;
        const bar = document.getElementById('wm-tools-bar');
        if (!bar || document.getElementById('wm-discard-launch')) return;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'wm-tool-button'; button.id = 'wm-discard-launch';
        button.textContent = 'Discard'; button.title = 'Préparer la défausse des exemplaires dont le prix moyen est inférieur ou égal au seuil choisi';
        button.addEventListener('click', openDialog);
        const ranking = [...bar.querySelectorAll('button')].find(element => element.textContent === 'Plus chères');
        if (ranking) ranking.insertAdjacentElement('afterend', button); else bar.append(button);
      }
      function openDialog() {
        if (dialog || active) return;
        const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
        const overlay = element('div', 'wm-modal-overlay'); overlay.id = 'wm-discard-dialog';
        const modal = element('div', 'wm-modal wm-discard-modal'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'wm-discard-heading');
        const heading = element('h2', '', `Discard · v${core.VERSION}`); heading.id = 'wm-discard-heading';
        const note = element('p', '', 'Sélection depuis le même cache que « Plus chères », en prix croissants. Moy. — après une requête réussie = 0 W pour cette sélection. Erreurs API, prix en attente et cartes jamais analysées sont exclus.');
        const protectedNote = element('p', 'wm-discard-protection', 'Toujours conservés : favoris, cartes brillantes, cartes en échange ou en vente. Aucune carte n’est défaussée avant ta confirmation.');
        const label = element('label', 'wm-discard-threshold', 'Prix moyen maximal (W) : ');
        const input = element('input'); input.type = 'number'; input.min = '0'; input.step = 'any'; input.value = '0'; input.id = 'wm-discard-threshold'; input.setAttribute('aria-label', 'Prix moyen maximal (W)'); label.append(input);
        const rarityFilter = element('fieldset', 'wm-discard-filters');
        rarityFilter.append(element('legend', '', 'Raretés à défausser'));
        const rarityChoices = element('div', 'wm-discard-rarity-choices'), rarityInputs = new Map();
        for (const rarity of [...model.RARITIES].reverse()) {
          const choice = element('label', 'wm-discard-rarity-choice');
          const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = model.DEFAULT_RARITIES.includes(rarity);
          checkbox.id = `wm-discard-rarity-${rarity}`;
          checkbox.addEventListener('change', updateFilters);
          choice.append(checkbox, element('span', '', rarity)); rarityChoices.append(choice); rarityInputs.set(rarity, checkbox);
        }
        rarityFilter.append(rarityChoices, element('small', '', 'C et PC uniquement par défaut. Une rareté décochée est conservée, quel que soit son prix.'));
        const selectedRarities = () => [...rarityInputs].filter(([, checkbox]) => checkbox.checked).map(([rarity]) => rarity);
        const status = element('p', 'wm-discard-status'); status.id = 'wm-discard-status'; status.setAttribute('aria-live', 'polite');
        const summary = element('p'); summary.id = 'wm-discard-summary';
        const list = element('div', 'wm-discard-list');
        const pagination = element('div', 'wm-discard-actions');
        const actions = element('div', 'wm-modal-actions wm-discard-actions');
        const ackLabel = element('label', 'wm-discard-ack');
        const ack = element('input'); ack.type = 'checkbox'; ack.id = 'wm-discard-ack';
        ackLabel.append(ack, document.createTextNode(' Je confirme la défausse définitive des exemplaires cochés.'));
        let preview = null, excluded = new Set(), page = 0, busy = false, executing = false, finished = false, siteChanged = false;
        const selectedRows = () => preview?.selected.filter(row => !excluded.has(row.ownedId)) || [];
        const updateConfirm = () => { confirm.textContent = `Défausser ${selectedRows().length} exemplaire(s)`; confirm.disabled = busy || finished || !ack.checked || !selectedRows().length; };
        const button = (text, action) => {
          const node = element('button', 'wm-tool-button', text); node.type = 'button';
          node.addEventListener('click', () => { Promise.resolve().then(action).catch(error => { status.textContent = error.message; }); }); actions.append(node); return node;
        };
        function renderPreview() {
          list.replaceChildren(); pagination.replaceChildren(); ack.checked = false;
          for (const checkbox of rarityInputs.values()) checkbox.disabled = busy || finished;
          if (!preview) { summary.textContent = ''; updateConfirm(); return; }
          const count = selectedRows().length, e = preview.excluded;
          summary.textContent = `${count} / ${preview.total} exemplaires sélectionnés ≤ ${preview.maximum} W. Exclus : ${e.rarity} hors raretés choisies ; ${e.unknown} en erreur, en attente ou jamais analysés ; ${e.above} au-dessus du seuil ; ${e.favorite + e.shiny + e.trade + e.sale} protégés connus.`;
          loadButton.hidden = preview.complete;
          const pages = Math.max(1, Math.ceil(preview.selected.length / 50)); page = Math.min(page, pages - 1);
          const copyCounts = new Map(), copyNumbers = new Map();
          for (const row of preview.selected) copyCounts.set(row.cardId, (copyCounts.get(row.cardId) || 0) + 1);
          for (const row of preview.selected.slice(0, page * 50)) copyNumbers.set(row.cardId, (copyNumbers.get(row.cardId) || 0) + 1);
          for (const row of preview.selected.slice(page * 50, (page + 1) * 50)) {
            const rowLabel = element('label', 'wm-discard-row');
            const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = !excluded.has(row.ownedId); checkbox.disabled = busy || finished;
            checkbox.setAttribute('aria-label', `Défausser ${row.title}`);
            checkbox.addEventListener('change', () => { if (checkbox.checked) excluded.delete(row.ownedId); else excluded.add(row.ownedId); ack.checked = false; summary.textContent = `${selectedRows().length} / ${preview.total} exemplaires sélectionnés ≤ ${preview.maximum} W.`; updateConfirm(); });
            const thumb = element('span', 'wm-ranking-thumb wm-discard-thumb');
            const fallback = element('span', 'wm-discard-image-placeholder', row.rarity); thumb.append(fallback);
            const imageUrl = row.imageUrl || core.cardMetaById?.get(row.cardId)?.imageUrl;
            if (imageUrl) {
              const img = element('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
              img.addEventListener('load', () => { fallback.hidden = true; });
              img.addEventListener('error', () => { img.remove(); fallback.hidden = false; });
              img.src = imageUrl; thumb.append(img);
            }
            const info = element('span', 'wm-ranking-info wm-discard-info');
            const name = element('span', 'wm-ranking-title wm-discard-title', row.title); name.title = row.title;
            const meta = element('span', 'wm-ranking-meta wm-discard-meta');
            meta.append(element('span', 'wm-discard-rarity', row.rarity));
            const copyNumber = (copyNumbers.get(row.cardId) || 0) + 1; copyNumbers.set(row.cardId, copyNumber);
            meta.append(element('span', '', copyCounts.get(row.cardId) > 1 ? `Exemplaire ${copyNumber} / ${copyCounts.get(row.cardId)}` : '1 exemplaire'));
            info.append(name, meta);
            const price = element('span', 'wm-ranking-price wm-discard-price');
            price.append(element('strong', '', `${runtime.priceUi.formatAverage(row.average)} W`),
              element('span', 'wm-discard-price-caption', row.noAverage ? 'Moy. —' : 'Prix moyen'));
            price.title = `${row.noAverage ? 'Moyenne absente après une requête réussie : comptée comme 0 W pour la sélection. ' : ''}Prix enregistré le ${new Date(row.fetchedAt).toLocaleString('fr-FR')} · exemplaire ${row.ownedId}`;
            rowLabel.append(checkbox, thumb, info, price); list.append(rowLabel);
          }
          if (pages > 1) {
            for (const [text, delta] of [['←', -1], ['→', 1]]) {
              const node = element('button', 'wm-tool-button', text); node.type = 'button'; node.disabled = busy || page + delta < 0 || page + delta >= pages;
              node.addEventListener('click', () => { page += delta; renderPreview(); }); pagination.append(node);
            }
            pagination.append(element('span', '', `Aperçu ${page + 1} / ${pages} · sélection sur toutes les pages`));
          }
          updateConfirm();
        }
        function setBusy(value) {
          busy = value; input.disabled = value; recalculateButton.disabled = value; loadButton.disabled = value; ack.disabled = value;
          for (const checkbox of rarityInputs.values()) checkbox.disabled = value || finished;
          stopButton.hidden = !value; closeButton.disabled = value;
          for (const node of list.querySelectorAll('input')) node.disabled = value || finished;
          updateConfirm();
        }
        function fromCache() {
          if (busy) return; finished = false; excluded.clear(); page = 0;
          preview = cachedPlan(input.value, selectedRarities()); renderPreview();
          const age = preview.scannedAt ? ` · collection enregistrée le ${new Date(preview.scannedAt).toLocaleString('fr-FR')}` : '';
          status.textContent = `Aperçu du cache${age}. ${preview.complete ? '' : 'Cache partiel : charge la collection complète pour inclure les autres exemplaires. '}Les protections seront revérifiées après confirmation, avant toute défausse.`;
        }
        const recalculateButton = button('Recalculer la sélection', fromCache);
        recalculateButton.id = 'wm-discard-recalculate'; recalculateButton.title = 'Mettre à jour la sélection après de nouveaux prix chargés : relit le cache et réinitialise les cases, sans demander de prix au serveur';
        const loadButton = button('Charger la collection complète', async () => {
          if (busy) return; finished = false; executing = false; excluded.clear(); page = 0; preview = null;
          setBusy(true); renderPreview();
          try { preview = await analyse(input.value, text => { status.textContent = text; }, selectedRarities()); status.textContent = 'Collection complète enregistrée. Prix croissants · utilise « Charger les prix » pour les prix encore absents.'; }
          finally { setBusy(false); renderPreview(); }
        }); loadButton.id = 'wm-discard-load-collection'; loadButton.title = 'Récupérer les exemplaires manquants sur toutes les pages ; aucun prix ne sera demandé';
        const confirm = button('Défausser 0 exemplaire(s)', async () => {
          if (busy || finished || !ack.checked || !selectedRows().length) return;
          const approved = selectedRows(); executing = true; setBusy(true);
          try {
            const report = await execute(approved, preview.maximum, update => { status.textContent = update.text; }, preview.rarities); finished = true;
            siteChanged ||= report.discarded > 0 || report.batches.some(batch => batch.status === 'unconfirmed');
            if (siteChanged) closeButton.textContent = 'Fermer et actualiser le site';
          }
          finally { executing = false; ack.checked = false; setBusy(false); renderPreview(); }
        }); confirm.id = 'wm-discard-confirm'; confirm.classList.add('wm-discard-danger');
        const stopButton = button('Arrêter', () => { stop(); status.textContent = executing ? 'Arrêt demandé · le lot en cours peut encore être défaussé, aucun nouveau lot ne partira.' : 'Arrêt demandé…'; }); stopButton.hidden = true;
        const closeButton = button('Fermer', () => { if (busy) return; overlay.remove(); dialog = null; if (siteChanged) location.reload(); });
        function updateFilters() {
          if (busy || finished) return;
          try { preview = currentPlan(input.value, selectedRarities()); excluded.clear(); page = 0; renderPreview(); }
          catch (error) { preview = null; renderPreview(); status.textContent = error.message; }
        }
        input.addEventListener('input', updateFilters);
        ack.addEventListener('change', updateConfirm); confirm.disabled = true;
        modal.append(heading, note, protectedNote, label, rarityFilter, status, summary, list, pagination, ackLabel, actions);
        overlay.append(modal); document.body.append(overlay); dialog = overlay;
        try { fromCache(); }
        catch (error) { status.textContent = error.message; loadButton.hidden = false; }
      }
      return { cachedPlan, analyse, currentPlan, execute, discardPulled, stop, ensureButton, openDialog, getReport: () => core.readLocalValue(REPORT_KEY) };
    }
  };
})();
