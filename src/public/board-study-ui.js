const STUDY_IMAGE_PATH = boardId => `/api/boards/${encodeURIComponent(boardId)}/study/image`;
const STUDY_FEEDBACK_PATH = boardId => `/api/boards/${encodeURIComponent(boardId)}/study/feedback`;

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('O navegador não conseguiu gerar o PNG.')), 'image/png');
  });
}

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}

function jsonRequest(response) {
  return response.json().catch(() => ({}));
}

export function mountBoardStudyUI({ boardId, canvas, mountedBoard }) {
  if (!boardId || !canvas || !mountedBoard?.insertTemplate || !mountedBoard?.renderSnapshot) {
    throw new TypeError('Board study UI requires an authorized board and a mounted Canvas.');
  }

  const galleryToggle = document.querySelector('#study-gallery-toggle');
  const gallery = document.querySelector('#study-gallery');
  const galleryClose = document.querySelector('#study-gallery-close');
  const filterButtons = [...document.querySelectorAll('[data-study-filter]')];
  const templateCards = document.querySelector('#study-template-cards');
  const templateSelect = document.querySelector('#study-template-select');
  const questionList = document.querySelector('#study-question-list');
  const studyLayout = document.querySelector('#study-layout');
  const sidebar = document.querySelector('#study-sidebar');
  const sidebarToggle = document.querySelector('#study-sidebar-toggle');
  const sidebarClose = document.querySelector('#study-sidebar-close');
  const tabs = [...document.querySelectorAll('[data-study-tab]')];
  const panels = [...document.querySelectorAll('.study-tab-panel')];
  const feedbackNotes = document.querySelector('#study-feedback-notes');
  const feedbackRefresh = document.querySelector('#study-feedback-refresh');
  const exportButton = document.querySelector('#study-export-png');
  const saveButton = document.querySelector('#study-save-image');
  const status = document.querySelector('#study-status');
  let templates = [];
  let destroyed = false;

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function setGalleryOpen(open) {
    gallery.hidden = !open;
    galleryToggle.setAttribute('aria-expanded', String(open));
    if (open) gallery.scrollIntoView({ block: 'nearest' });
  }

  function setSidebarOpen(open) {
    sidebar.hidden = !open;
    sidebarToggle.setAttribute('aria-expanded', String(open));
    studyLayout.style.gridTemplateColumns = open ? 'minmax(0, 1fr) minmax(16rem, 21rem)' : '1fr';
  }

  function applyFilter(category) {
    for (const button of filterButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.studyFilter === category));
    }
    for (const card of templateCards.querySelectorAll('[data-template-category]')) {
      card.hidden = category !== 'all' && card.dataset.templateCategory !== category;
    }
  }

  function reportInsertion(result, title) {
    setStatus(result === 'pending'
      ? `${title} ficará visível neste navegador e será enviado quando a conexão voltar.`
      : `${title} adicionado ao quadro.`);
  }

  async function insertTemplate(template) {
    setStatus(`Carregando ${template.title}…`);
    try {
      const result = await mountedBoard.insertTemplate(template);
      reportInsertion(result, template.title);
      setGalleryOpen(false);
    } catch (error) {
      setStatus(error.message ?? 'Não foi possível inserir o diagrama.');
    }
  }

  function createTemplateCard(template) {
    const card = document.createElement('article');
    card.className = 'study-template-card';
    card.dataset.templateCategory = template.category;
    const category = document.createElement('small');
    category.textContent = `${template.badge || 'Diagrama'} · ${template.category}`;
    const title = document.createElement('strong');
    title.textContent = template.title;
    const description = document.createElement('p');
    description.textContent = template.desc || template.filename;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Acrescentar ao quadro';
    button.addEventListener('click', () => { void insertTemplate(template); });
    card.append(category, title, description, button);
    return card;
  }

  function populateTemplateCatalog(catalog) {
    templates = catalog;
    templateCards.replaceChildren(...catalog.map(createTemplateCard));
    templateSelect.replaceChildren(new Option('Selecione um diagrama…', ''));
    const categoryGroups = new Map();
    for (const template of catalog) {
      let group = categoryGroups.get(template.category);
      if (!group) {
        group = document.createElement('optgroup');
        group.label = template.category;
        categoryGroups.set(template.category, group);
        templateSelect.append(group);
      }
      const option = new Option(template.title, template.filename);
      group.append(option);
    }
    questionList.replaceChildren();
    for (const template of catalog.filter(item => item.category === '🏆 Prova Real (UFSM)' || item.category === 'Exercícios dos Slides')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'study-question-button';
      button.textContent = template.title;
      button.addEventListener('click', () => { void insertTemplate(template); });
      questionList.append(button);
    }
    applyFilter('all');
  }

  async function loadTemplateCatalog() {
    try {
      const response = await fetch('/api/templates', { credentials: 'same-origin', cache: 'no-store' });
      const catalog = await jsonRequest(response);
      if (!response.ok || !Array.isArray(catalog)) throw new Error('Não foi possível carregar a galeria de diagramas.');
      populateTemplateCatalog(catalog);
      if (!catalog.length) setStatus('Nenhum template disponível no servidor.');
    } catch (error) {
      setStatus(error.message ?? 'Não foi possível carregar a galeria de diagramas.');
    }
  }

  async function refreshFeedback() {
    feedbackNotes.textContent = 'Carregando anotações…';
    try {
      const response = await fetch(STUDY_FEEDBACK_PATH(boardId), { credentials: 'same-origin', cache: 'no-store' });
      const result = await jsonRequest(response);
      if (!response.ok) throw new Error(result.error ?? 'Não foi possível carregar as anotações.');
      feedbackNotes.replaceChildren();
      if (!result.notes?.length) {
        feedbackNotes.textContent = 'Nenhuma anotação salva para este quadro.';
        return;
      }
      for (const note of result.notes) {
        const article = document.createElement('article');
        const author = document.createElement('strong');
        author.textContent = note.author || 'Anotação';
        const text = document.createElement('p');
        text.textContent = note.text;
        article.append(author, text);
        feedbackNotes.append(article);
      }
    } catch (error) {
      feedbackNotes.textContent = error.message ?? 'Não foi possível carregar as anotações.';
    }
  }

  async function saveManualBoardImage() {
    saveButton.disabled = true;
    setStatus('Gerando PNG do conteúdo compartilhado…');
    let snapshotCanvas;
    try {
      snapshotCanvas = await mountedBoard.renderSnapshot();
      const blob = await canvasToPng(snapshotCanvas);
      const response = await fetch(STUDY_IMAGE_PATH(boardId), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'image/png' },
        body: blob,
      });
      const result = await jsonRequest(response);
      if (!response.ok) throw new Error(result.error ?? 'Não foi possível salvar a imagem do quadro.');
      setStatus(`Imagem do quadro salva para análise (${Math.ceil(result.byteLength / 1024)} KiB). Nenhuma inferência automática foi executada.`);
      return result;
    } catch (error) {
      setStatus(error.message ?? 'Não foi possível salvar a imagem do quadro.');
      throw error;
    } finally {
      if (snapshotCanvas) {
        snapshotCanvas.width = 0;
        snapshotCanvas.height = 0;
      }
      saveButton.disabled = false;
    }
  }

  async function exportLocalPng() {
    exportButton.disabled = true;
    try {
      const blob = await canvasToPng(canvas);
      downloadBlob(blob, `whiteboard_mips_${Date.now()}.png`);
      setStatus('PNG do Canvas baixado neste dispositivo.');
    } catch (error) {
      setStatus(error.message ?? 'Não foi possível exportar o PNG.');
    } finally {
      exportButton.disabled = false;
    }
  }

  const onGalleryToggle = () => setGalleryOpen(gallery.hidden);
  const onGalleryClose = () => setGalleryOpen(false);
  const onSidebarToggle = () => setSidebarOpen(sidebar.hidden);
  const onSidebarClose = () => setSidebarOpen(false);
  const onExport = () => { void exportLocalPng(); };
  const onSave = () => { void saveManualBoardImage().catch(() => {}); };
  const onFeedbackRefresh = () => { void refreshFeedback(); };
  const onSelectTemplate = () => {
    const template = templates.find(item => item.filename === templateSelect.value);
    if (!template) return;
    templateSelect.value = '';
    void insertTemplate(template);
  };
  const onEscape = event => {
    if (event.key !== 'Escape') return;
    setGalleryOpen(false);
    setSidebarOpen(false);
  };
  const filterListeners = filterButtons.map(button => {
    const listener = () => applyFilter(button.dataset.studyFilter);
    button.addEventListener('click', listener);
    return [button, listener];
  });
  const tabListeners = tabs.map(tab => {
    const listener = () => {
      for (const candidate of tabs) candidate.setAttribute('aria-selected', String(candidate === tab));
      for (const panel of panels) {
        const active = panel.id === `study-panel-${tab.dataset.studyTab}`;
        panel.hidden = !active;
        panel.classList.toggle('active', active);
      }
      if (tab.dataset.studyTab === 'feedback') void refreshFeedback();
    };
    tab.addEventListener('click', listener);
    return [tab, listener];
  });
  galleryToggle.addEventListener('click', onGalleryToggle);
  galleryClose.addEventListener('click', onGalleryClose);
  sidebarToggle.addEventListener('click', onSidebarToggle);
  sidebarClose.addEventListener('click', onSidebarClose);
  feedbackRefresh.addEventListener('click', onFeedbackRefresh);
  exportButton.addEventListener('click', onExport);
  saveButton.addEventListener('click', onSave);
  templateSelect.addEventListener('change', onSelectTemplate);
  document.addEventListener('keydown', onEscape);
  void loadTemplateCatalog();

  return {
    saveManualBoardImage,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      galleryToggle.removeEventListener('click', onGalleryToggle);
      galleryClose.removeEventListener('click', onGalleryClose);
      sidebarToggle.removeEventListener('click', onSidebarToggle);
      sidebarClose.removeEventListener('click', onSidebarClose);
      feedbackRefresh.removeEventListener('click', onFeedbackRefresh);
      exportButton.removeEventListener('click', onExport);
      saveButton.removeEventListener('click', onSave);
      templateSelect.removeEventListener('change', onSelectTemplate);
      document.removeEventListener('keydown', onEscape);
      for (const [button, listener] of filterListeners) button.removeEventListener('click', listener);
      for (const [tab, listener] of tabListeners) tab.removeEventListener('click', listener);
    },
  };
}
