exports.handler = async (event) => {
  const GITHUB_REPO = 'brucey1777/champion-gymnastics-york';
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // optional — public repo works without it
  const folder = event.queryStringParameters?.folder || 'training';

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'CGY-Site',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${folder}`,
      { headers }
    );

    if (res.status === 404) {
      return {
        statusCode: 200,
        body: JSON.stringify({ files: [], message: 'Folder not found — create it by uploading a file' }),
      };
    }

    const data = await res.json();

    // If it's a directory listing, recursively get subfolders
    const files = [];
    for (const item of data) {
      if (item.type === 'file' && (
        item.name.endsWith('.pdf') ||
        item.name.endsWith('.mp4') ||
        item.name.endsWith('.mov') ||
        item.name.endsWith('.docx') ||
        item.name.endsWith('.jpg') ||
        item.name.endsWith('.jpeg') ||
        item.name.endsWith('.png')
      )) {
        files.push({
          name: item.name,
          path: item.path,
          size: item.size,
          downloadUrl: item.download_url,
          htmlUrl: item.html_url,
        });
      } else if (item.type === 'dir') {
        // Fetch subfolder contents
        const subRes = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/contents/${item.path}`,
          { headers }
        );
        const subData = await subRes.json();
        for (const subItem of subData) {
          if (subItem.type === 'file') {
            files.push({
              name: subItem.name,
              path: subItem.path,
              size: subItem.size,
              downloadUrl: subItem.download_url,
              htmlUrl: subItem.html_url,
              folder: item.name,
            });
          }
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ files }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
