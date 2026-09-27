"use strict";

// ============================================================================
//  Анализатор структуры фреймов для Figma + локальная LLM Qwen
// ============================================================================

figma.showUI(__html__, { width: 440, height: 740, themeColors: true });

const DEFAULTS = {
  apiUrl: "http://localhost:8080/v1/chat/completions",
  apiKey: "test",
  modelName: "Qwen/Qwen3.5-27B-AWQ",
  useLLM: true,
  timeoutMs: 60000,
  maxTokens: 200,
  disableThinking: true,

  renameMinor: true,        // также именовать мелкие элементы
  useLLMForMinor: true,     // использовать LLM для сложных контейнеров
  minorMaxDepth: 8,         // ограничение глубины рекурсии

  headingFontSize: 48,
  headingTolerance: 6,
  headerWidth: 958,
  headerHeight: 56,
  headerWTolerance: 30,     // допуск по ширине хедера
  headerHTolerance: 8,      // допуск по высоте хедера
  footerTotalHeight: 479,
  footerTolerance: 20,      // допуск на сумму высот двух нижних блоков футера
  cardSizeBucket: 16,
  cardMinCount: 2,
};

figma.ui.onmessage = async (msg) => {
  if (msg.type === "analyze") {
    const config = Object.assign({}, DEFAULTS, msg);
    try { await runAnalysis(config); }
    catch (e) { log("Ошибка: " + describeError(e)); }
    finally { done(); }
  } else if (msg.type === "test") {
    const config = Object.assign({}, DEFAULTS, msg);
    try { await testConnection(config); }
    catch (e) { log("Тест провалился: " + describeError(e)); }
    finally { done(); }
  } else if (msg.type === "close") {
    figma.closePlugin();
  }
};

function log(text) { figma.ui.postMessage({ type: "log", text: text }); }
function done() { figma.ui.postMessage({ type: "done" }); }

// ============================================================================
//  Тест подключения
// ============================================================================
async function testConnection(config) {
  log("Тестирую подключение к " + config.apiUrl + " …");
  const baseUrl = config.apiUrl.replace(/\/chat\/completions\/?$/, "");
  const modelsUrl = baseUrl.replace(/\/$/, "") + "/models";

  log("\n[1/2] GET " + modelsUrl);
  try {
    const r = await fetchWithTimeout(modelsUrl, {
      method: "GET",
      headers: { "Authorization": "Bearer " + config.apiKey },
    }, config.timeoutMs);
    log("  Статус: " + r.status + " " + r.statusText);
    log("  Ответ: " + (await r.text()).substring(0, 300));
  } catch (e) { log("  ✗ " + describeError(e)); }

  log("\n[2/2] POST " + config.apiUrl);
  try {
    const r = await fetchWithTimeout(config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey },
      body: JSON.stringify(buildRequestBody("Ответь одним словом: тест", "Отвечай очень коротко.", config)),
    }, config.timeoutMs);
    log("  Статус: " + r.status + " " + r.statusText);
    const txt = await r.text();
    log("  Ответ: " + txt.substring(0, 500));
    if (r.ok) {
      try {
        const content = extractContent(JSON.parse(txt));
        if (content) log("\n  ✓ Модель ответила: «" + content + "»");
        else log("\n  ⚠ В ответе нет content. Проверьте, что thinking отключён.");
      } catch (_) {}
    }
  } catch (e) { log("  ✗ " + describeError(e)); }
  log("\n— Конец теста —");
}

// ============================================================================
//  Главный цикл
// ============================================================================
async function runAnalysis(config) {
  let frames = [];
  if (config.scope === "selection") {
    frames = figma.currentPage.selection.filter((n) => n.type === "FRAME");
    if (frames.length === 0) { log("Не выделено ни одного фрейма."); return; }
  } else {
    frames = figma.currentPage.children.filter((n) => n.type === "FRAME");
    if (frames.length === 0) { log("На странице нет фреймов."); return; }
  }

  log("Найдено фреймов: " + frames.length);
  for (let i = 0; i < frames.length; i++) {
    log("\n[" + (i + 1) + "/" + frames.length + "] Фрейм «" + frames[i].name + "»");
    try { await analyzeFrame(frames[i], config); }
    catch (e) { log("  Ошибка: " + describeError(e)); }
  }
  log("\n✓ Анализ завершён.");
}

async function analyzeFrame(frame, config) {
  if (!("children" in frame) || frame.children.length === 0) {
    log("  Фрейм пуст — пропускаем."); return;
  }

  // 0. Очищаем все служебные имена, оставшиеся от прежних запусков.
  // Гарантия: после анализа "Хедер", "Футер N", "Карточка N", "Главный блок"
  // и т.п. появятся ИСКЛЮЧИТЕЛЬНО на тех узлах, куда их поставит текущий запуск.
  const cleared = clearReservedNames(frame);
  if (cleared > 0) log("  ↺ Сброшено старых служебных имён: " + cleared);

  const children = frame.children.slice().sort((a, b) => a.y - b.y);

  // Хедер: самый верхний прямой ребёнок фрейма с подходящей ВЫСОТОЙ.
  // Высота — основной признак (тонкая полоса), ширина проверяется как
  // дополнительная подсказка: если не совпала, в лог идёт предупреждение,
  // но узел всё равно становится хедером.
  let headerNode = null;
  let headerSkipReason = "";
  if (children.length > 0) {
    const top = children[0];
    const dH = Math.abs(top.height - config.headerHeight);
    const dW = Math.abs(top.width - config.headerWidth);
    if (dH <= config.headerHTolerance) {
      headerNode = top;
      if (dW > config.headerWTolerance) {
        log("  ℹ Хедер: ширина " + Math.round(top.width) +
            " отличается от ожидаемой " + config.headerWidth +
            " (Δ=" + Math.round(dW) + "), но высота совпадает — принимаем как хедер.");
      }
    } else {
      headerSkipReason = "верхний элемент имеет высоту " + Math.round(top.height) +
        ", ожидается " + config.headerHeight +
        " (расхождение " + Math.round(dH) + ")";
    }
  }

  // Футер: РОВНО последние 2 блока фрейма, их высоты в сумме ≈ footerTotalHeight.
  // По спецификации футер всегда состоит из 2 блоков, никаких fallback'ов на 1 блок.
  let footerNodes = [];
  let footerSkipReason = "";
  if (children.length >= 2) {
    const last2 = children.slice(-2);
    const sum = last2[0].height + last2[1].height;
    const d = Math.abs(sum - config.footerTotalHeight);
    if (d <= config.footerTolerance) {
      footerNodes = last2;
    } else {
      footerSkipReason = "сумма высот двух нижних блоков (" +
        Math.round(last2[0].height) + " + " + Math.round(last2[1].height) + " = " +
        Math.round(sum) + ") не совпадает с ожидаемой " + config.footerTotalHeight +
        " (расхождение " + Math.round(d) + ")";
    }
  } else {
    footerSkipReason = "во фрейме меньше 2 дочерних элементов";
  }

  const headerIdx = headerNode ? children.indexOf(headerNode) : -1;
  const footerStartIdx = footerNodes.length > 0 ? children.indexOf(footerNodes[0]) : children.length;
  const middle = [];
  for (let i = headerIdx + 1; i < footerStartIdx; i++) middle.push(children[i]);

  const mainNode = middle.length > 0 ? middle[0] : null;
  const secondaryNodes = middle.slice(1);

  if (headerNode) {
    headerNode.name = "Хедер";
    log("  • Хедер  (" + Math.round(headerNode.width) + "×" + Math.round(headerNode.height) + ")");
    await processInnerElements(headerNode, "Хедер", config);
  } else {
    log("  ⚠ Хедер не распознан" + (headerSkipReason ? ": " + headerSkipReason : "") + ".");
  }

  if (mainNode) {
    mainNode.name = "Главный блок";
    log("  • Главный блок  (" + Math.round(mainNode.width) + "×" + Math.round(mainNode.height) + ")");
    await processInnerElements(mainNode, "Главный блок", config);
  } else log("  ⚠ Главный блок не найден.");

  for (let i = 0; i < secondaryNodes.length; i++) {
    const node = secondaryNodes[i];
    const heading = findHeading(node, config);
    let blockName = "Второстепенный блок " + (i + 1);
    if (heading && heading.characters && heading.characters.trim()) {
      const headText = heading.characters.trim();
      const llmName = await nameBlockByHeading(headText, config);
      if (llmName) {
        blockName = llmName;
      } else if (!RESERVED_NAME_RE.test(headText)) {
        // Используем сам заголовок как имя, но только если он не содержит
        // зарезервированных слов (хедер/футер/...)
        blockName = headText.substring(0, 50);
      }
      // иначе оставляем "Второстепенный блок N"
    }
    node.name = blockName;
    log("  • " + blockName + "  (" + Math.round(node.width) + "×" + Math.round(node.height) + ")");
    await processInnerElements(node, blockName, config);
  }

  for (let i = 0; i < footerNodes.length; i++) {
    const node = footerNodes[i];
    const name = footerNodes.length > 1 ? "Футер " + (i + 1) : "Футер";
    node.name = name;
    log("  • " + name + "  (" + Math.round(node.width) + "×" + Math.round(node.height) + ")");
    await processInnerElements(node, name, config);
  }
  if (footerNodes.length === 0) {
    log("  ⚠ Футер не распознан" + (footerSkipReason ? ": " + footerSkipReason : "") + ".");
  }
  // Имя "Футер" получают РОВНО последние 2 блока фрейма. Никакой блок в середине
  // не будет назван футером, даже если его высота случайно близка к 479.
}

async function processInnerElements(blockNode, blockName, config) {
  const heading = findHeading(blockNode, config);
  let headingText = "";
  if (heading) {
    headingText = (heading.characters || "").trim();
    heading.name = "Заголовок " + blockName + (headingText ? ": " + headingText.substring(0, 40) : "");
    if (headingText) log("      ↳ Заголовок: «" + headingText.substring(0, 60) + "»");
  }

  const cards = findCards(blockNode, config);
  if (cards.length > 0) {
    log("      ↳ Найдено карточек: " + cards.length);
    for (let i = 0; i < cards.length; i++) {
      const text = collectText(cards[i], 200);
      let name = "Карточка " + (i + 1);
      if (text) {
        const llmName = await nameCard(text, config);
        if (llmName) name = llmName;
      }
      cards[i].name = name;
      log("         " + (i + 1) + ". " + name);
    }
  }

  // Переименование мелких элементов
  if (config.renameMinor) {
    const ctx = blockName + (headingText ? " («" + headingText.substring(0, 40) + "»)" : "");
    const counter = { renamed: 0, llmCalls: 0 };
    await renameMinorElements(blockNode, ctx, config, 0, counter);
    if (counter.renamed > 0) {
      log("      ↳ Переименовано мелких элементов: " + counter.renamed +
          (counter.llmCalls > 0 ? " (из них через LLM: " + counter.llmCalls + ")" : ""));
    }
  }
}

// ============================================================================
//  Переименование мелких элементов (текст, иконки, контейнеры)
// ============================================================================
// Базовое множество корней «генеричных» имён слоёв. Проверка через токенизатор —
// имя разбивается на токены, и если ВСЕ токены сидят в этом множестве, имя
// считается генеричным и переименовывается. Это ловит как одиночные имена
// ("Frame", "Links"), так и составные ("Text Block", "Icon Container", "iconButton").
const GENERIC_TOKENS = new Set([
  // EN: типы Figma + множественные
  "frame","frames","group","groups","rectangle","rectangles","ellipse","ellipses",
  "vector","vectors","line","lines","polygon","polygons","star","stars",
  "arrow","arrows","slice","slices","image","images","component","components",
  "instance","instances","mask","masks","shape","shapes","boolean","operation",
  "booleanoperation",
  // EN: UI-роли
  "icon","icons","container","containers","button","buttons","text","texts",
  "label","labels","title","titles","subtitle","subtitles","heading","headings",
  "subheading","subheadings","caption","captions","description","descriptions",
  "placeholder","placeholders","item","items","element","elements","wrapper",
  "wrappers","content","contents","body","bodies","tag","tags","badge","badges",
  "chip","chips","pill","pills","list","lists","section","sections","row","rows",
  "column","columns","col","cols","block","blocks","card","cards","hero",
  "heros","sidebar","sidebars","avatar","avatars","logo","logos","banner",
  "banners","menu","menus","nav","navs","navigation","link","links","cell",
  "cells","field","fields","input","inputs","panel","panels","stack","stacks",
  "div","spacer","spacers","divider","dividers","separator","separators",
  "background","bg","overlay","overlays","modal","modals","dialog","dialogs",
  "tooltip","tooltips","popup","popups","popover","popovers","tab","tabs",
  "accordion","accordions","iconography","subhead","footer","header",
  // RU
  "фрейм","фреймы","группа","группы","прямоугольник","прямоугольники",
  "эллипс","эллипсы","линия","линии","звезда","звёзды","стрелка","стрелки",
  "иконка","иконки","кнопка","кнопки","контейнер","контейнеры","текст",
  "тексты","заголовок","заголовки","подзаголовок","подпись","подписи",
  "описание","описания","метка","метки","тег","теги","элемент","элементы",
  "колонка","колонки","строка","строки","блок","блоки","меню","логотип",
  "логотипы","баннер","баннеры","аватар","аватары","поле","поля","карточка",
  "карточки","список","списки","секция","секции","маска","маски","картинка",
  "картинки","изображение","изображения","надпись","надписи","ссылка",
  "ссылки","разделитель","разделители","фон","оверлей","модалка","модалки",
  "вкладка","вкладки","панель","панели","блоки","группы","шапка","подвал"
]);

// Множество "пустых" текстов-плейсхолдеров (для содержимого TEXT-узлов).
// Если текст совпадает с одним из этих слов, плагин не использует сам текст
// как имя слоя — вместо этого идёт в LLM с контекстом соседей.
const PLACEHOLDER_WORDS = new Set([
  // EN singular + plural
  "label","labels","title","titles","text","texts","heading","headings",
  "subheading","subheadings","subtitle","subtitles","caption","captions",
  "description","descriptions","placeholder","placeholders","button","buttons",
  "item","items","element","elements","content","contents","body","name","value",
  "message","sample","tag","tags","badge","badges","chip","chips","pill","pills",
  "subhead","link","links","menu","menus","nav","navs","field","fields","input",
  "inputs","header","headers","footer","footers","label text","button text",
  "lorem","ipsum",
  // RU
  "метка","метки","заголовок","заголовки","текст","тексты","подзаголовок",
  "подпись","подписи","описание","описания","кнопка","кнопки","элемент",
  "элементы","имя","значение","тег","теги","образец","плейсхолдер","надпись",
  "надписи","ссылка","ссылки","меню","поле","поля","ввод","шапка","подвал"
]);

function isPlaceholderText(t) {
  if (!t) return true;
  const s = String(t).trim().toLowerCase();
  if (!s) return true;
  if (PLACEHOLDER_WORDS.has(s)) return true;
  if (/^lorem\s+ipsum/i.test(s)) return true;
  if (/^[\.\-_=*~·•]+$/.test(s)) return true;
  return false;
}

// Имя считается генеричным, если состоит ТОЛЬКО из служебных слов и/или цифр.
// Это ловит "Frame", "Text", "Links", "Text Block", "Icon Container",
// "iconButton" (camelCase), "card-row-3" и т.п.
function isGenericName(name) {
  if (!name) return true;
  const raw = String(name).trim();
  if (!raw) return true;
  if (/^\d+$/.test(raw)) return true;

  // Разбиваем имя на токены: camelCase → пробел, потом split по разделителям
  const tokens = raw
    .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, "$1 $2")
    .split(/[\s/\-_:]+/)
    .map((t) => t.replace(/^\d+|\d+$/g, "").toLowerCase())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return true;
  if (tokens.length > 5) return false; // длинные имена скорее всего смысловые

  // Генеричное, если все токены в множестве служебных
  for (const t of tokens) {
    if (!GENERIC_TOKENS.has(t)) return false;
  }
  return true;
}

function cleanText(t, maxLen) {
  if (!maxLen) maxLen = 50;
  let s = String(t || "").trim().replace(/\s+/g, " ");
  s = s.replace(/^[\.,;:!?\-—•·]+|[\.,;:!?\-—•·]+$/g, "").trim();
  if (s.length > maxLen) s = s.substring(0, maxLen).trim() + "…";
  return s;
}

// Узел похож на иконку: вектор, булева операция, или маленький фрейм только из векторов
function isIconLike(node) {
  if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") return true;
  if (node.type === "FRAME" || node.type === "GROUP" || node.type === "INSTANCE" || node.type === "COMPONENT") {
    if (typeof node.width === "number" && node.width <= 80 && node.height <= 80) {
      if ("children" in node && node.children.length > 0) {
        return node.children.every((c) => {
          if (c.type === "VECTOR" || c.type === "BOOLEAN_OPERATION") return true;
          if (c.type === "RECTANGLE" || c.type === "ELLIPSE" || c.type === "LINE" ||
              c.type === "POLYGON" || c.type === "STAR") return true;
          return isIconLike(c);
        });
      }
    }
  }
  return false;
}

function findFirstText(node) {
  if (node.type === "TEXT" && typeof node.characters === "string" && node.characters.trim()) {
    return node.characters.trim();
  }
  if ("children" in node) {
    for (const c of node.children) {
      const t = findFirstText(c);
      if (t) return t;
    }
  }
  return "";
}

// Найти текст брата-соседа (для контекста иконки)
function findSiblingText(parent, ofNode) {
  if (!("children" in parent)) return "";
  for (const c of parent.children) {
    if (c === ofNode) continue;
    const t = findFirstText(c);
    if (t) return t;
  }
  return "";
}

// Собрать все осмысленные тексты соседей (для контекста при именовании
// placeholder-элемента — нужно понимать, среди чего он стоит).
function collectSiblingTexts(parent, ofNode, maxLength) {
  if (!("children" in parent)) return "";
  const parts = [];
  for (const c of parent.children) {
    if (c === ofNode) continue;
    const t = collectText(c, 100);
    if (t && !isPlaceholderText(t)) parts.push(t);
  }
  let combined = parts.join(" | ").trim();
  if (combined.length > maxLength) combined = combined.substring(0, maxLength) + "…";
  return combined;
}

async function renameMinorElements(node, blockContext, config, depth, counter) {
  if (!("children" in node) || depth > config.minorMaxDepth) return;

  for (const child of node.children) {
    if (child.visible === false) continue;
    // Не лезем внутрь instance — там override-значения, обычно их трогать не надо
    const isInstance = child.type === "INSTANCE";

    if (isGenericName(child.name)) {
      const newName = await suggestName(child, node, blockContext, config, counter);
      if (newName) { child.name = newName; counter.renamed++; }
    }

    if (!isInstance) {
      await renameMinorElements(child, blockContext, config, depth + 1, counter);
    }
  }
}

async function suggestName(child, parent, blockContext, config, counter) {
  // 1) Текст
  if (child.type === "TEXT") {
    const txt = (child.characters || "").trim();
    if (!txt) return "";
    // Если текст осмысленный (не placeholder) — берём его как имя
    if (!isPlaceholderText(txt) && !RESERVED_NAME_RE.test(txt)) {
      return cleanText(txt, 50);
    }
    // Placeholder вроде "Label"/"Title" — даём LLM собрать имя по контексту
    if (config.useLLMForMinor && config.useLLM) {
      const sibText = collectSiblingTexts(parent, child, 200);
      counter.llmCalls++;
      const llmName = await nameTextElement(txt, sibText, blockContext, config);
      if (llmName) return llmName;
    }
    // Худший случай: оставляем как было
    return "";
  }

  // 2) Иконка
  if (isIconLike(child)) {
    const sibText = findSiblingText(parent, child);
    if (sibText && !isPlaceholderText(sibText) && !RESERVED_NAME_RE.test(sibText)) {
      return "Иконка «" + cleanText(sibText, 24) + "»";
    }
    return "Иконка";
  }

  // 3) Контейнер
  if (child.type === "FRAME" || child.type === "GROUP" ||
      child.type === "COMPONENT" || child.type === "INSTANCE") {
    const allText = collectText(child, 200);
    const firstText = findFirstText(child);

    // Быстрый путь: если внутри один короткий ОСМЫСЛЕННЫЙ текст — берём его
    const firstIsGood = firstText && firstText.length <= 40 &&
                        !RESERVED_NAME_RE.test(firstText) &&
                        !isPlaceholderText(firstText);
    if (firstIsGood) return cleanText(firstText, 40);

    // Иначе — пробуем LLM с полным содержимым и контекстом блока
    if (allText && config.useLLMForMinor && config.useLLM) {
      counter.llmCalls++;
      const llmName = await nameContainer(allText, blockContext, config);
      if (llmName) return llmName;
    }

    // Fallback: если LLM отказала, но есть хотя бы какой-то осмысленный текст
    if (firstText && !RESERVED_NAME_RE.test(firstText) && !isPlaceholderText(firstText)) {
      return cleanText(firstText, 40);
    }
    return "";
  }

  // 4) Фигуры — обычно не нужны имена, но дадим намёк по геометрии
  if (child.type === "RECTANGLE" || child.type === "ELLIPSE") {
    // тонкая широкая полоса → разделитель; большое прямоугольное → фон
    if (child.type === "RECTANGLE") {
      if (child.height <= 4 && child.width > 50) return "Разделитель";
      if (parent && typeof parent.width === "number" &&
          child.width >= parent.width * 0.9 && child.height >= parent.height * 0.9) {
        return "Фон";
      }
    }
    return ""; // оставляем как есть
  }

  return "";
}

// ============================================================================
//  Поиск заголовков и карточек
// ============================================================================
function findHeading(rootNode, config) {
  let result = null;
  function walk(n) {
    if (result) return;
    if (n.type === "TEXT") {
      const size = getMaxFontSize(n);
      if (Math.abs(size - config.headingFontSize) <= config.headingTolerance) { result = n; return; }
    }
    if ("children" in n) for (const c of n.children) { walk(c); if (result) return; }
  }
  walk(rootNode);
  return result;
}

function getMaxFontSize(textNode) {
  const fs = textNode.fontSize;
  if (typeof fs === "number") return fs;
  try {
    const segs = textNode.getStyledTextSegments(["fontSize"]);
    let max = 0;
    for (const s of segs) if (typeof s.fontSize === "number" && s.fontSize > max) max = s.fontSize;
    return max;
  } catch (e) { return 0; }
}

function findCards(blockNode, config) {
  function tryLevel(node) {
    if (!("children" in node)) return [];
    const candidates = node.children.filter((c) =>
      c.type === "FRAME" || c.type === "COMPONENT" || c.type === "INSTANCE" || c.type === "GROUP"
    );
    if (candidates.length >= config.cardMinCount) {
      const bucket = config.cardSizeBucket;
      const groups = new Map();
      for (const c of candidates) {
        const key = Math.round(c.width / bucket) + "x" + Math.round(c.height / bucket);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      let largest = [];
      for (const g of groups.values()) if (g.length > largest.length) largest = g;
      if (largest.length >= config.cardMinCount) return largest;
    }
    for (const c of candidates) {
      const inner = tryLevel(c);
      if (inner.length >= config.cardMinCount) return inner;
    }
    return [];
  }
  return tryLevel(blockNode);
}

function collectText(node, maxLength) {
  const parts = [];
  function walk(n) {
    if (n.type === "TEXT" && typeof n.characters === "string") parts.push(n.characters);
    if ("children" in n) for (const c of n.children) walk(c);
  }
  walk(node);
  let combined = parts.join(" | ").replace(/\s+/g, " ").trim();
  if (combined.length > maxLength) combined = combined.substring(0, maxLength) + "…";
  return combined;
}

// ============================================================================
//  Запрос к LLM (с отключением thinking-режима Qwen3)
// ============================================================================
function buildRequestBody(userPrompt, systemPrompt, config) {
  const body = {
    model: config.modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: config.maxTokens,
    stream: false,
  };
  if (config.disableThinking) {
    body.chat_template_kwargs = { enable_thinking: false };
    body.extra_body = { chat_template_kwargs: { enable_thinking: false } };
  }
  return body;
}

function extractContent(data) {
  if (!data || !data.choices || !data.choices[0]) return "";
  const msg = data.choices[0].message || {};
  let content = msg.content;
  if (content && typeof content === "string" && content.trim()) return content.trim();
  const reasoning = msg.reasoning || msg.reasoning_content;
  if (reasoning && typeof reasoning === "string") {
    const lines = reasoning.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return "";
}

async function fetchWithTimeout(url, options, timeoutMs) {
  let timer = null;
  const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
  if (controller) {
    options = Object.assign({}, options, { signal: controller.signal });
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try { return await fetch(url, options); }
  finally { if (timer) clearTimeout(timer); }
}

function describeError(e) {
  if (!e) return "неизвестная ошибка";
  if (e.name === "AbortError") return "таймаут запроса";
  const parts = [];
  if (e.name) parts.push(e.name);
  if (e.message) parts.push(e.message);
  let s = parts.join(": ") || String(e);
  if (/failed to fetch|networkerror|load failed/i.test(s)) {
    s += "\n      Запустите CORS-прокси: python3 cors_proxy.py" +
         "\n      и укажите в API URL: http://localhost:8080/v1/chat/completions";
  }
  return s;
}

async function callLLM(userPrompt, systemPrompt, config) {
  if (!config.useLLM) return "";
  try {
    const response = await fetchWithTimeout(config.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + config.apiKey },
      body: JSON.stringify(buildRequestBody(userPrompt, systemPrompt, config)),
    }, config.timeoutMs);
    if (!response.ok) {
      const body = await response.text();
      throw new Error("HTTP " + response.status + " — " + body.substring(0, 200));
    }
    const content = extractContent(await response.json());
    if (!content) return "";
    return sanitizeName(content);
  } catch (e) {
    log("      ⚠ LLM недоступна: " + describeError(e));
    config.useLLM = false;
    return "";
  }
}

// Имена, которые LLM не должна выдавать — они зарезервированы под структурные блоки.
// Используется в sanitizeName (substring match с \b).
const RESERVED_NAME_RE = /\b(хедер|футер|header|footer|шапка|подвал|navbar|navigation\s+bar|главн[ыоа][йея]\s+блок|main\s+block|основн[ыоа][йея]\s+блок|второстепенн[ыоа][йея]\s+блок|secondary\s+block|карточка\s*\d*)\b/i;

// Точное (full-string) сопоставление — для очистки старых служебных имён в макете.
// Сбрасываются ТОЛЬКО узлы, чьё имя ЦЕЛИКОМ равно служебному (с опциональным " N").
// Заголовки вида "Заголовок Главный блок: Каталог" сюда не попадут — там есть приставка.
const RESERVED_EXACT_RE = /^(хедер|футер(?:\s+\d+)?|header|footer(?:\s+\d+)?|шапка|подвал|главн[ыоа][йея]\s+блок|основн[ыоа][йея]\s+блок|main\s+block|второстепенн[ыоа][йея]\s+блок(?:\s+\d+)?|secondary\s+block(?:\s+\d+)?|карточка(?:\s+\d+)?|card(?:\s+\d+)?)$/i;

// Очищает старые служебные имена во всём поддереве, чтобы их можно было заново
// проставить только на структурно правильных узлах текущего фрейма.
function clearReservedNames(rootNode) {
  let count = 0;
  function walk(n) {
    if (!("children" in n)) return;
    for (const c of n.children) {
      if (c.name && RESERVED_EXACT_RE.test(c.name.trim())) {
        // Сбрасываем в дефолтное имя, чтобы isGenericName распознал и заново обработал
        c.name = defaultNameForType(c.type);
        count++;
      }
      walk(c);
    }
  }
  walk(rootNode);
  return count;
}

function defaultNameForType(type) {
  switch (type) {
    case "FRAME":             return "Frame";
    case "GROUP":             return "Group";
    case "TEXT":              return "Text";
    case "RECTANGLE":         return "Rectangle";
    case "ELLIPSE":           return "Ellipse";
    case "VECTOR":            return "Vector";
    case "LINE":              return "Line";
    case "POLYGON":           return "Polygon";
    case "STAR":              return "Star";
    case "COMPONENT":         return "Component";
    case "INSTANCE":          return "Instance";
    case "BOOLEAN_OPERATION": return "BooleanOperation";
    default:                  return "Frame";
  }
}

function sanitizeName(s) {
  let r = String(s).trim();
  r = r.replace(/^<think>[\s\S]*?<\/think>\s*/i, "");
  r = r.replace(/^thinking process[\s\S]*?($|\n)/i, "");
  r = r.replace(/^(название|имя|ответ|name|title)\s*[:\-—]\s*/i, "");
  r = r.replace(/^["'«»]+|["'«»\.]+$/g, "");
  r = r.split(/\n/)[0].trim();
  if (r.length > 60) r = r.substring(0, 60).trim();
  if (RESERVED_NAME_RE.test(r)) return "";
  // Отбрасываем ответы, состоящие только из латиницы — LLM должна отвечать на русском
  if (isLatinOnly(r)) return "";
  return r;
}

// true, если строка содержит латинские буквы, но НИ ОДНОЙ кириллической.
// Чистые числа, валюты, символы и кириллица с латиницей вместе — OK.
function isLatinOnly(s) {
  const hasLatin = /[a-z]/i.test(s);
  const hasCyrillic = /[а-яё]/i.test(s);
  return hasLatin && !hasCyrillic;
}

// Общий системный промпт для всех LLM-задач именования
const SYS_RU = [
  "Ты помогаешь именовать слои в дизайне Figma на русском языке.",
  "",
  "ПРАВИЛА:",
  "1. Отвечай ВСЕГДА на русском. Английские слова в содержимом обязательно переводи: " +
    "Buy → Купить, Cart → Корзина, Sign up → Регистрация.",
  "2. Ответ — только короткое имя (1-4 слова), без кавычек, пояснений, без префиксов вроде «Имя:» или «Ответ:».",
  "3. ИСПОЛЬЗУЙ КОНКРЕТНЫЕ СЛОВА из содержимого — главное название, заголовок, ключевое существительное. " +
    "Не придумывай отвлечённые формулировки.",
  "4. Имя должно отражать СУТЬ и СОДЕРЖИМОЕ, а не тип элемента.",
  "",
  "ЗАПРЕЩЕНО использовать слова: хедер, футер, шапка, подвал, главный блок, " +
    "второстепенный блок, карточка, label, title, text, item, container, block, " +
    "wrapper, content — слишком общие.",
  "",
  "ПРИМЕРЫ:",
  "Содержимое: «Концерт Чайковского | 28 июня | Большой зал | 1500 ₽»",
  "Имя: Концерт Чайковского",
  "",
  "Содержимое: «Купить билет»",
  "Имя: Кнопка покупки",
  "",
  "Содержимое: «Войти через VK | Войти через Google»",
  "Имя: Кнопки входа",
  "",
  "Содержимое: «Контакты | support@example.com | +7 495 123-45-67»",
  "Имя: Контакты компании",
  "",
  "Содержимое: «© 2024 ООО Компания»",
  "Имя: Копирайт",
  "",
  "Содержимое: «About | Privacy | Terms»",
  "Имя: Ссылки в подвале"
].join("\n");

async function nameCard(text, config) {
  if (!text) return "";
  return await callLLM(
    "Содержимое карточки в Figma:\n«" + text + "»\n\n" +
    "Дай ей имя слоя — 1-3 слова на русском, отражающее СУТЬ. " +
    "Используй ключевые слова из содержимого (заголовок, главное существительное).",
    SYS_RU,
    config
  );
}

async function nameBlockByHeading(headingText, config) {
  if (!headingText) return "";
  return await callLLM(
    "Заголовок UI-блока в Figma: «" + headingText + "».\n\n" +
    "Дай блоку имя слоя — 2-4 слова на русском, основанное на словах из заголовка.",
    SYS_RU,
    config
  );
}

async function nameContainer(text, blockContext, config) {
  if (!text) return "";
  return await callLLM(
    "В Figma есть контейнер. Он находится в блоке «" + blockContext + "».\n" +
    "Содержимое контейнера:\n«" + text + "»\n\n" +
    "Дай контейнеру имя слоя — 1-3 слова на русском, используя ключевые слова из содержимого.",
    SYS_RU,
    config
  );
}

// Для placeholder-текстов вроде "Label", "Title" — генерируем имя по контексту соседей.
async function nameTextElement(text, siblingsText, blockContext, config) {
  return await callLLM(
    "В Figma есть текстовый слой с placeholder-содержимым «" + (text || "(пусто)") + "» — " +
    "это шаблонная подпись, смысла она не несёт.\n" +
    (siblingsText ? "Соседние элементы содержат: «" + siblingsText + "».\n" : "") +
    "Слой находится в блоке: «" + blockContext + "».\n\n" +
    "Дай этому текстовому слою имя — 1-3 слова на русском, " +
    "описывающее его РОЛЬ среди соседей (например: «Цена», «Дата события», «Имя автора»).",
    SYS_RU,
    config
  );
}
