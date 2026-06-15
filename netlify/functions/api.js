// =============================================
// PureTube API — Netlify Serverless Function
// Handles: video info, search, trending, subtitles
// Video playback uses direct URLs (no proxy needed)
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

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

// ---- Helpers ----
function respond(data, status = 200) {
  return {
    statusCode: status,
    headers: HEADERS,
    body: JSON.stringify(data),
  };
}

function getRunText(obj) {
  if (!obj) return '';
  if (obj.simpleText) return obj.simpleText;
  if (obj.runs && obj.runs.length) return obj.runs.map(r => r.text).join('');
  return '';
}

function getThumb(thumbnails) {
  if (!thumbnails || !Array.isArray(thumbnails) || !thumbnails.length) return '';
  return thumbnails[thumbnails.length - 1].url || '';
}

function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\s*\n/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

// ---- InnerTube Client ----
async function innertube(endpoint, body) {
  const res = await fetch(`${INNERTUBE_API}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'X-Goog-Api-Format-Version': '2',
    },
    body: JSON.stringify({ ...CLIENT, ...body }),
  });
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  return res.json();
}

// ---- Format Parsing ----
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
    url: f.url,  // Direct URL — no proxy needed
  };
}

function extractFormats(sd) {
  if (!sd) return { play: [], video: [], audio: [], all: [] };
  const combined = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
  const all = [], play = [], video = [], audio = [];
  for (const f of combined) {
    const n = normalizeFormat(f);
    if (!n) continue;
    all.push(n);
    if (n.hasVideo && n.hasAudio) play.push(n);
    else if (n.hasVideo) video.push(n);
    else if (n.hasAudio) audio.push(n);
  }
  play.sort((a, b) => b.height - a.height);
  video.sort((a, b) => b.height - a.height);
  audio.sort((a, b) => b.bitrate - a.bitrate);
  return { play, video, audio, all };
}

// ---- Video Renderer ----
function parseVR(vr) {
  if (!vr || !vr.videoId) return null;
  return {
    id: vr.videoId,
    type: 'video',
    title: getRunText(vr.title),
    thumbnail: getThumb(vr.thumbnail?.thumbnails),
    duration: parseInt(vr.lengthSeconds) || 0,
    durationText: getRunText(vr.lengthText),
    author: getRunText(vr.ownerText || vr.longBylineText),
    views: getRunText(vr.viewCountText || vr.shortViewCountText),
    published: getRunText(vr.publishedTimeText),
    isLive: !!(vr.badges && vr.badges.some(b => b.metadataBadgeRenderer?.label === 'LIVE')),
  };
}

// ---- Route Handlers ----

async function handleVideo(params) {
  const id = params.id;
  if (!id) return respond({ error: 'Missing id' }, 400);

  const data = await innertube('player', { videoId: id });
  const ps = data.playabilityStatus || {};
  if (ps.status !== 'OK') {
    return respond({ error: ps.reason || ps.messages?.join(' ') || 'Video unavailable' }, 422);
  }

  const vd = data.videoDetails || {};
  const sd = data.streamingData || {};
  const captions = data.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const formats = extractFormats(sd);

  // Subtitles — metadata only, VTT fetched on demand
  const subtitles = captions.map(c => ({
    language: c.languageCode || '',
    name: getRunText(c.name) || c.languageCode || '',
    isAuto: c.kind === 'asr',
    baseUrl: c.baseUrl || '',
  }));

  // Related
  const related = [];
  try {
    const results = data.contents?.twoColumnWatchNextResults
      ?.secondaryResults?.secondaryResultsRenderer?.results || [];
    for (const r of results) {
      if (r.compactVideoRenderer) related.push(parseVR(r.compactVideoRenderer));
    }
  } catch (e) { /* ignore */ }

  return respond({
    id: vd.videoId || id,
    title: vd.title || '',
    thumbnail: getThumb(vd.thumbnail?.thumbnails),
    duration: parseInt(vd.lengthSeconds) || 0,
    author: vd.author || '',
    description: vd.shortDescription || '',
    viewCount: parseInt(vd.viewCount) || 0,
    subtitles,
    formats,
    relatedVideos: related.filter(Boolean),
  });
}

async function handleSearch(params) {
  const query = params.q;
  const continuation = params.continuation;

  let data;
  if (continuation) {
    data = await innertube('search', { continuation });
    const items = data.continuationContents?.itemSectionContinuation?.contents || [];
    const next = data.continuationContents?.itemSectionContinuation
      ?.continuations?.[0]?.nextContinuationToken || null;
    return respond({ videos: items.map(parseVR).filter(Boolean), continuation: next });
  }

  if (!query) return respond({ error: 'Missing q' }, 400);
  data = await innertube('search', { query });
  const sections = data.contents?.twoColumnSearchResultsRenderer
    ?.primaryContents?.sectionListRenderer?.contents || [];
  const items = sections[0]?.itemSectionRenderer?.contents || [];
  const next = sections[0]?.itemSectionRenderer
    ?.continuations?.[0]?.nextContinuationToken || null;
  return respond({ videos: items.map(parseVR).filter(Boolean), continuation: next });
}

async function handleTrending(params) {
  const continuation = params.continuation;
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
    }

    for (const item of items) {
      const vr = item.richItemRenderer?.content?.videoRenderer || item.videoRenderer;
      if (vr) videos.push(parseVR(vr));
    }
  } catch (e) { /* ignore */ }

  return respond({ videos: videos.filter(Boolean), continuation: nextToken });
}

async function handleSubtitle(params) {
  const url = params.url;
  if (!url) return respond({ error: 'Missing url' }, 400);

  try {
    const srtUrl = url + (url.includes('?') ? '&' : '?') + 'fmt=srv3';
    const res = await fetch(srtUrl);
    if (!res.ok) {
      // Try raw
      const raw = await fetch(url);
      const text = await raw.text();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/vtt; charset=utf-8', ...HEADERS },
        body: 'WEBVTT\n\n' + text,
      };
    }
    const srt = await res.text();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/vtt; charset=utf-8', ...HEADERS },
      body: srtToVtt(srt),
    };
  } catch (e) {
    return respond({ error: 'Subtitle fetch failed' }, 500);
  }
}

// ---- Router ----
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: HEADERS, body: '' };
  }

  // Parse route from path (handles both /api/video and /.netlify/functions/api/video)
  let route = event.path || '';
  route = route.replace(/^\/\.netlify\/functions\/api\/?/, '');
  route = route.replace(/^\/api\/?/, '');
  route = route.split('?')[0].split('/')[0] || '';

  const params = event.queryStringParameters || {};

  try {
    switch (route) {
      case 'video':    return await handleVideo(params);
      case 'search':   return await handleSearch(params);
      case 'trending': return await handleTrending(params);
      case 'subtitle': return await handleSubtitle(params);
      default:         return respond({ error: 'Not found' }, 404);
    }
  } catch (err) {
    console.error('Function error:', err);
    return respond({ error: err.message || 'Internal error' }, 500);
  }
};
