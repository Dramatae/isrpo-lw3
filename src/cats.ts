export function memePage(title: string, imageSrc: string | undefined, cspSource: string): string {
  const body = imageSrc
    ? `<img src="${imageSrc}" alt="мем с котиком">`
    : `<div class="empty">😺<br>Тут будет мем с котиком.<br>
         Положите картинки (png, jpg, gif, webp) в папку <code>media/memes</code> внутри проекта.</div>`;

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground);
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  h2 { margin: 0 0 16px 0; font-weight: 600; }
  img {
    max-width: 100%;
    max-height: 75vh;
    border-radius: 12px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  }
  .empty { text-align: center; line-height: 1.8; opacity: 0.85; font-size: 15px; }
</style>
</head>
<body>
  <h2>${title}</h2>
  ${body}
</body>
</html>`;
}