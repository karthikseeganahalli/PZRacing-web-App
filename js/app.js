// Plain script (no ES modules) so the app works when index.html is opened
// directly from disk. parseSES / toVBO / toCSV come from parser.js and
// exporters.js, which must load before this file.

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const results = document.getElementById('results');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragging');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  handleFiles(e.dataTransfer.files);
});

async function handleFiles(files) {
  for (const file of files) {
    const card = document.createElement('div');
    card.className = 'card';
    results.prepend(card);

    try {
      const buffer = await file.arrayBuffer();
      const session = parseSES(buffer);
      renderSession(card, file, session);
    } catch (err) {
      card.classList.add('error');
      card.innerHTML = `<h3>${escapeHtml(file.name)}</h3><p>${escapeHtml(err.message)}</p>`;
    }
  }
  fileInput.value = '';
}

function renderSession(card, file, session) {
  const { header, records } = session;
  const duration = records.length ? records[records.length - 1].t : 0;
  const min = Math.floor(duration / 60);
  const sec = Math.round(duration % 60);
  const channels = header.analogChannels.filter((c) => c.enabled).map((c) => c.name);
  const warnings = session.warnings || [];
  const baseName = file.name.replace(/\.ses$/i, '');

  card.innerHTML = `
    <h3>${escapeHtml(file.name)}</h3>
    <dl>
      <div><dt>Rider</dt><dd>${escapeHtml(header.name || '—')}</dd></div>
      <div><dt>Vehicle</dt><dd>${escapeHtml(header.vehicle || '—')}</dd></div>
      <div><dt>Track</dt><dd>${escapeHtml(header.track || '—')}</dd></div>
      <div><dt>Date</dt><dd>${escapeHtml(header.date)} ${escapeHtml(header.time)}</dd></div>
      <div><dt>Duration</dt><dd>${min}:${String(sec).padStart(2, '0')}</dd></div>
      <div><dt>Samples</dt><dd>${records.length.toLocaleString()} @ 50 Hz</dd></div>
      <div><dt>Channels</dt><dd>${escapeHtml(channels.join(', ') || '—')}</dd></div>
    </dl>
    ${warnings.map((w) => `<p class="note">⚠ ${escapeHtml(w)}</p>`).join('')}
    <div class="actions">
      <button class="btn btn-primary" data-format="vbo">Download .VBO (RaceChrono)</button>
      <button class="btn" data-format="csv">Download .CSV</button>
    </div>
  `;

  card.querySelector('[data-format="vbo"]').addEventListener('click', () => {
    download(`${baseName}.vbo`, toVBO(session), 'text/plain');
  });
  card.querySelector('[data-format="csv"]').addEventListener('click', () => {
    download(`${baseName}.csv`, toCSV(session), 'text/csv');
  });
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
