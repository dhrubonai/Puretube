// =============================================
// PureTube API - Netlify Edge Function
// YouTube InnerTube proxy for video streaming
// =============================================

const INNERTUBE_API = 'https://www.youtube.com/youtubei/v1';
const CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '19.29.37',
  androidSdkVersion: 30,
  hl: 'en',
  gl: 'US',
  utcOffsetMinutes: 0,
};
const UA = 'com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
};


function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function getThumbnail(thumbnails) {
  if (!thumbnails || !Array.isArray(thumbnails) || thumbnails.length === 0) return '';
  return thumbnails[thumbnails.length - 1].url || '';
}

function getRunText(obj) {
  if (!obj) return '';
  if (obj.simpleText) return obj.simpleText;
  if (obj.runs && obj.runs.length > 0) return obj.runs.map(r => r.text).join('');
  return '';
}



function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\s*\n/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}



async function innertube(endpoint, body) {
  const res = await fetch(`${INNERTUBE_API}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'X-Goog-Api-Format-Version': '2',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({ ...CLIENT, ...body }),
  });
  if (!res.ok) throw new Error(`InnerTube ${endpoint} failed: ${res.status}`);
  return res.json();
}


function normalizeFormat(f) {
  if (!f || !f.url) return null;
  return {
    itag: f.itag,
    quality: f.qualityLabel || f.quality || `${f.height || '?'}p`,
    mimeType: f.mimeType || '',
    bitrate: f.bitrate || 0,
    hasVideo: !!f.hasVideo,
    hasAudio: !!f.hasAudio,
    width: f.width || 0,
    height: f.height || 0,
    fps: f.fps || 0,
    contentLength: f.contentLength ? parseInt(f.contentLength) : 0,
    proxyUrl: `/api/proxy?url=${encodeURIComponent(f.url)}`,
  };
}

function extractFormats(streamingData) {
  if (!streamingData) return { play: [], video: [], audio: [], all: [] };
  const combined = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];
  const all = [];
  const play = [];
  const video = [];
  const audio = [];

  for (const f of combined) {
    const n = normalizeFormat(f);
    if (!n) continue;
    all.push(n);
    if (n.hasVideo && n.hasAudio) play.push(n);
    else if (n.hasVideo && !n.hasAudio) video.push(n);
    else if (!n.hasVideo && n.hasAudio) audio.push(n);
  }

  play.sort((a, b) => b.height - a.height);
  video.sort((a, b) => b.height - a.height);
  audio.sort((a, b) => b.bitrate - a.bitrate);

  return { play, video, audio, all };
}

function parseVideoRenderer(vr) {
  if (!vr || !vr.videoId) return null;
  return {
    id: vr.videoId,
    type: 'video',
    title: getRunText(vr.title),
    thumbnail: getThumbnail(vr.thumbnail?.thumbnails),
    duration: parseInt(vr.lengthSeconds) || 0,
    durationText: getRunText(vr.lengthText),
    author: getRunText(vr.ownerText || vr.longBylineText),
    views: getRunText(vr.viewCountText || vr.shortViewCountText),
    published: getRunText(vr.publishedTimeText),
    isLive: !!(vr.badges && vr.badges.some(b =>
      b.metadataBadgeRenderer && b.metadataBadgeRenderer.label === 'LIVE'
    )),
  };
}



async function handleVideo(url) {
  const videoId = url.searchParams.get('id');
  if (!videoId) return json({ error: 'Missing video id' }, 400);

  const data = await innertube('player', { videoId });

  
  const ps = data.playabilityStatus || {};
  if (ps.status !== 'OK') {
    return json({
      error: ps.reason || ps.messages?.join(' ') || 'Video unavailable',
      status: ps.status,
    }, 422);
  }

  const vd = data.videoDetails || {};
  const sd = data.streamingData || {};
  const captions = data.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];


  let hlsUrl = null;
  if (sd.hlsManifestUrl) {
    hlsUrl = `/api/hls?url=${encodeURIComponent(sd.hlsManifestUrl)}`;
  }

  
  const subtitles = captions.map(c => ({
    language: c.languageCode || '',
    name: getRunText(c.name) || c.languageCode || '',
    isAuto: c.kind === 'asr',
    url: c.baseUrl ? `/api/proxy?url=${encodeURIComponent(c.baseUrl)}&fmt=vtt` : null,
  }));

  
  const formats = extractFormats(sd);

  
  const related = [];
  try {
    const results = data.contents?.twoColumnWatchNextResults
      ?.secondaryResults?.secondaryResultsRenderer?.results || [];
    for (const r of results) {
      const vr = r.compactVideoRenderer;
      if (vr && vr.videoId) {
        related.push(parseVideoRenderer(vr));
      }
    }
  } catch (e) {
    console.error('Failed to extract related:', e);
  }

  return json({
    id: vd.videoId || videoId,
    title: vd.title || '',
    thumbnail: getThumbnail(vd.thumbnail?.thumbnails),
    duration: parseInt(vd.lengthSeconds) || 0,
    author: vd.author || '',
    authorThumbnail: '',
    description: vd.shortDescription || '',
    viewCount: parseInt(vd.viewCount) || 0,
    keywords: vd.keywords || [],
    hlsUrl,
    subtitles,
    formats,
    relatedVideos: related.filter(Boolean),
  });
}



async function handleSearch(url) {
  const query = url.searchParams.get('q');
  const continuation = url.searchParams.get('continuation');

  let data;
  if (continuation) {
    data = await innertube('search', { continuation });
    const items = data.continuationContents?.itemSectionContinuation?.contents || [];
    const nextToken = data.continuationContents?.itemSectionContinuation
      ?.continuations?.[0]?.nextContinuationToken || null;
    return json({ videos: items.map(parseVideoRenderer).filter(Boolean), continuation: nextToken });
  } else {
    if (!query) return json({ error: 'Missing search query' }, 400);
    data = await innertube('search', { query });
    const sectionContents = data.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents || [];
    const items = sectionContents[0]?.itemSectionRenderer?.contents || [];
    const nextToken = sectionContents[0]?.itemSectionRenderer
      ?.continuations?.[0]?.nextContinuationToken || null;
    return json({ videos: items.map(parseVideoRenderer).filter(Boolean), continuation: nextToken });
  }
}



async function handleTrending(url) {
  const continuation = url.searchParams.get('continuation');

  let data;
  if (continuation) {
    data = await innertube('browse', { continuation });
  } else {
    data = await innertube('browse', { browseId: 'FEtrending' });
  }

  const videos = [];
  let nextToken = null;

  try {
    const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    const tabContent = tabs[0]?.tabRenderer?.content;

    let items = [];
    if (tabContent?.richGridRenderer) {
      items = tabContent.richGridRenderer.contents || [];
      const contItem = items.find(c => c.continuationItemRenderer);
      if (contItem) {
        nextToken = contItem.continuationItemRenderer
          ?.continuationEndpoint?.continuationCommand?.token || null;
      }
    } else if (tabContent?.sectionListRenderer) {
      const sections = tabContent.sectionListRenderer.contents || [];
      if (sections.length > 0) {
        items = sections[0]?.itemSectionRenderer?.contents || [];
      }
    }

    for (const item of items) {
      const vr = item.richItemRenderer?.content?.videoRenderer || item.videoRenderer;
      if (vr) videos.push(parseVideoRenderer(vr));
    }
  } catch (e) {
    console.error('Failed to extract trending:', e);
  }

  return json({ videos: videos.filter(Boolean), continuation: nextToken });
}



async function handleProxy(url, request) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) return json({ error: 'Missing url parameter' }, 400);

  
  if (url.searchParams.get('fmt') === 'vtt' && targetUrl.includes('timedtext')) {
    try {
      const srtUrl = targetUrl + (targetUrl.includes('?') ? '&' : '?') + 'fmt=srv3';
      const res = await fetch(srtUrl);
      if (!res.ok) {
        // Fallback: try fetching raw and wrapping as VTT
        const raw = await res.text();
        return new Response('WEBVTT\n\n' + raw, {
          headers: { 'Content-Type': 'text/vtt; charset=utf-8', ...CORS },
        });
      }
      const srt = await res.text();
      return new Response(srtToVtt(srt), {
        headers: { 'Content-Type': 'text/vtt; charset=utf-8', ...CORS },
      });
    } catch (e) {
      return json({ error: 'Subtitle conversion failed: ' + e.message }, 500);
    }
  }

  // Stream proxy (video/audio)
  const headers = {};
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  try {
    const res = await fetch(targetUrl, { headers, redirect: 'follow' });

    const respHeaders = {
      'Accept-Ranges': 'bytes',
      ...CORS,
    };
    const ct = res.headers.get('Content-Type');
    if (ct) respHeaders['Content-Type'] = ct;
    const cl = res.headers.get('Content-Length');
    if (cl) respHeaders['Content-Length'] = cl;
    const cr = res.headers.get('Content-Range');
    if (cr) respHeaders['Content-Range'] = cr;

    return new Response(res.body, {
      status: res.status,
      headers: respHeaders,
    });
  } catch (e) {
    return json({ error: 'Proxy fetch failed: ' + e.message }, 502);
  }
}

// ---- Route: /api/hls ----

async function handleHls(url) {
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) return json({ error: 'Missing url parameter' }, 400);

  try {
    const res = await fetch(targetUrl);
    if (!res.ok) return json({ error: 'HLS fetch failed: ' + res.status }, 502);

    let text = await res.text();
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
    const isMaster = text.includes('#EXT-X-STREAM-INF');
    const rewritePath = isMaster ? '/api/hls' : '/api/proxy';

    const lines = text.split('\n');
    const rewritten = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      let resolved = trimmed;
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        resolved = trimmed;
      } else {
        resolved = baseUrl + trimmed;
      }

      return `${rewritePath}?url=${encodeURIComponent(resolved)}`;
    });

    return new Response(rewritten.join('\n'), {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...CORS },
    });
  } catch (e) {
    return json({ error: 'HLS processing failed: ' + e.message }, 500);
  }
}

// ---- Route: /api/download ----

async function handleDownload(url) {
  const videoId = url.searchParams.get('id');
  const itag = url.searchParams.get('itag');
  if (!videoId || !itag) return json({ error: 'Missing id or itag' }, 400);

  try {
    const data = await innertube('player', { videoId });
    const sd = data.streamingData || {};
    const allFormats = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
    const format = allFormats.find(f => String(f.itag) === String(itag));

    if (!format || !format.url) {
      return json({ error: 'Format not found or not playable' }, 404);
    }

    const vd = data.videoDetails || {};
    const safeName = (vd.title || videoId).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const ext = (format.mimeType || '').includes('audio') ? 'm4a' : 'mp4';

    // Redirect to proxy with Content-Disposition via a streaming proxy
    const res = await fetch(format.url);
    const respHeaders = {
      'Content-Type': format.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName + '.' + ext)}`,
      'Accept-Ranges': 'bytes',
      ...CORS,
    };
    const cl = res.headers.get('Content-Length');
    if (cl) respHeaders['Content-Length'] = cl;

    return new Response(res.body, {
      status: res.status,
      headers: respHeaders,
    });
  } catch (e) {
    return json({ error: 'Download failed: ' + e.message }, 500);
  }
}

// ---- Router ----

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  try {
    if (path === '/api/video') return handleVideo(url);
    if (path === '/api/search') return handleSearch(url);
    if (path === '/api/trending') return handleTrending(url);
    if (path === '/api/proxy') return handleProxy(url, request);
    if (path === '/api/hls') return handleHls(url);
    if (path === '/api/download') return handleDownload(url);

    return json({ error: 'Not found', path }, 404);
  } catch (err) {
    console.error('Edge function error:', err);
    return json({ error: err.message || 'Internal server error' }, 500);
  }
};
