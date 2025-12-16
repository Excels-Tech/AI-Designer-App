import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { composeMultiView } from './compose';
import { generateAllViews } from './generate';
import type { GenerateRequestBody, GenerateResponseBody, ViewId } from './types';
import { query } from './db';
import { buildPublicUrl, ensureUploadsDir, writeDataUrlToFile, uploadsRoot } from './storage';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const app = express();
const PORT = process.env.PORT || 8787;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(process.cwd(), 'build')));
app.use('/uploads', express.static(uploadsRoot));

ensureUploadsDir(uploadsRoot);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

type CreateDesignPayload = {
  title?: string;
  prompt: string;
  style: string;
  resolution: number;
  format?: string;
  quality?: string;
  combinedImage: string;
  views: { view: string; image: string }[];
};

async function saveDesignToDisk(
  designId: string,
  versionId: string,
  payload: CreateDesignPayload
) {
  const versionDir = path.join(uploadsRoot, 'designs', designId, versionId);
  ensureUploadsDir(versionDir);

  const fmt = (payload.format || 'png').toLowerCase();
  const ext = fmt.includes('webp') ? 'webp' : fmt.includes('jp') ? 'jpg' : 'png';
  const combinedPath = path.join(versionDir, `combined.${ext}`);
  writeDataUrlToFile(payload.combinedImage, combinedPath);
  const combinedUrl = buildPublicUrl(combinedPath);

  const views = payload.views.map((view) => {
    const viewPath = path.join(versionDir, `${view.view}.${ext}`);
    writeDataUrlToFile(view.image, viewPath);
    return { view: view.view, url: buildPublicUrl(viewPath) };
  });

  return { combinedUrl, views };
}

async function createDesignRecord(designId: string, payload: CreateDesignPayload) {
  await query(
    `insert into designs (id, title, created_at, updated_at) values ($1, $2, now(), now())`,
    [designId, payload.title || 'Untitled Design']
  );
}

async function createVersionRecord(
  designId: string,
  versionId: string,
  payload: CreateDesignPayload,
  combinedUrl: string,
  viewUrls: { view: string; url: string }[]
) {
  await query(
    `insert into design_versions (id, design_id, combined_image_url, prompt, style, resolution, format, quality, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      versionId,
      designId,
      combinedUrl,
      payload.prompt,
      payload.style,
      payload.resolution,
      payload.format || 'png',
      payload.quality || 'max',
    ]
  );

  for (const v of viewUrls) {
    await query(
      `insert into design_views (id, version_id, view, image_url, created_at) values ($1, $2, $3, $4, now())`,
      [crypto.randomUUID(), versionId, v.view, v.url]
    );
  }

  await query(`update designs set updated_at = now() where id = $1`, [designId]);
}

app.post('/api/designs', async (req, res) => {
  try {
    const body = req.body as CreateDesignPayload;
    if (!body.prompt || !body.style || !body.resolution || !body.combinedImage) {
      throw new Error('Missing required fields');
    }
    const designId = crypto.randomUUID();
    const versionId = crypto.randomUUID();

    const saved = await saveDesignToDisk(designId, versionId, body);
    await createDesignRecord(designId, body);
    await createVersionRecord(designId, versionId, body, saved.combinedUrl, saved.views);

    res.json({
      designId,
      versionId,
      combinedImageUrl: saved.combinedUrl,
      views: saved.views,
    });
  } catch (err: any) {
    console.error('Create design failed', err);
    res.status(500).json({ error: err.message || 'Failed to save design' });
  }
});

app.post('/api/designs/:designId/versions', async (req, res) => {
  try {
    const designId = req.params.designId;
    const body = req.body as CreateDesignPayload;
    if (!designId) throw new Error('Missing designId');
    if (!body.prompt || !body.style || !body.resolution || !body.combinedImage) {
      throw new Error('Missing required fields');
    }

    const exists = await query('select 1 from designs where id = $1', [designId]);
    if (!exists.rowCount) {
      return res.status(404).json({ error: 'Design not found' });
    }

    const versionId = crypto.randomUUID();
    const saved = await saveDesignToDisk(designId, versionId, body);
    await createVersionRecord(designId, versionId, body, saved.combinedUrl, saved.views);

    res.json({
      designId,
      versionId,
      combinedImageUrl: saved.combinedUrl,
      views: saved.views,
    });
  } catch (err: any) {
    console.error('Add version failed', err);
    res.status(500).json({ error: err.message || 'Failed to save version' });
  }
});

app.get('/api/designs', async (_req, res) => {
  try {
    const result = await query<{
      id: string;
      title: string;
      updated_at: string;
      combined_image_url: string | null;
      version_count: number | null;
    }>(
      `
      select d.id, d.title, d.updated_at,
        v.combined_image_url,
        cnt.version_count
      from designs d
      left join lateral (
        select dv.combined_image_url
        from design_versions dv
        where dv.design_id = d.id
        order by dv.created_at desc
        limit 1
      ) v on true
      left join lateral (
        select count(*) as version_count from design_versions dv where dv.design_id = d.id
      ) cnt on true
      order by d.updated_at desc
    `
    );
    res.json(
      result.rows.map((row) => ({
        designId: row.id,
        title: row.title,
        updatedAt: row.updated_at,
        combinedImageUrl: row.combined_image_url,
        versionCount: row.version_count || 0,
      }))
    );
  } catch (err: any) {
    console.error('List designs failed', err);
    res.status(500).json({ error: err.message || 'Failed to list designs' });
  }
});

app.get('/api/designs/:id', async (req, res) => {
  try {
    const designId = req.params.id;
    const designResult = await query<{
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    }>('select id, title, created_at, updated_at from designs where id = $1', [designId]);

    if (!designResult.rows.length) {
      return res.status(404).json({ error: 'Design not found' });
    }

    const versions = await query<{
      id: string;
      combined_image_url: string;
      created_at: string;
      prompt: string;
      style: string;
      resolution: number;
      format: string;
      quality: string;
    }>(
      `select id, combined_image_url, created_at, prompt, style, resolution, format, quality
       from design_versions
       where design_id = $1
       order by created_at desc`,
      [designId]
    );

    const versionIds = versions.rows.map((v) => v.id);
    const views =
      versionIds.length === 0
        ? []
        : (
            await query<{
              id: string;
              version_id: string;
              view: string;
              image_url: string;
            }>(
              `select id, version_id, view, image_url from design_views where version_id = ANY($1::uuid[])`,
              [versionIds]
            )
          ).rows;

    res.json({
      designId,
      title: designResult.rows[0].title,
      createdAt: designResult.rows[0].created_at,
      updatedAt: designResult.rows[0].updated_at,
      versions: versions.rows.map((v) => ({
        versionId: v.id,
        createdAt: v.created_at,
        combinedImage: v.combined_image_url,
        prompt: v.prompt,
        style: v.style,
        resolution: v.resolution,
        format: v.format,
        quality: v.quality,
        crops: views
          .filter((vw) => vw.version_id === v.id)
          .map((vw) => ({ view: vw.view, dataUrl: vw.image_url })),
        views: views.filter((vw) => vw.version_id === v.id).map((vw) => vw.view),
      })),
    });
  } catch (err: any) {
    console.error('Get design failed', err);
    res.status(500).json({ error: err.message || 'Failed to fetch design' });
  }
});

app.delete('/api/designs/:id', async (req, res) => {
  try {
    const designId = req.params.id;
    const designDir = path.join(uploadsRoot, 'designs', designId);

    await query(
      'delete from design_views where version_id in (select id from design_versions where design_id = $1)',
      [designId]
    );
    await query('delete from design_versions where design_id = $1', [designId]);
    await query('delete from designs where id = $1', [designId]);

    fs.rmSync(designDir, { recursive: true, force: true });

    res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete design failed', err);
    res.status(500).json({ error: err.message || 'Failed to delete design' });
  }
});

app.post('/api/generate-image', async (req, res) => {
  console.log('[server] /api/generate-image called');
  console.log('Payload:', req.body);

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is missing');
    }

    const { prompt, style, resolution, views } = req.body as GenerateRequestBody;

    if (!prompt) throw new Error('prompt missing');
    if (!style) throw new Error('style missing');
    if (!resolution) throw new Error('resolution missing');
    if (!Array.isArray(views) || views.length === 0) {
      throw new Error('views missing or empty');
    }

    console.log('[server] Input validated');

    const body: GenerateRequestBody = { prompt, style, resolution, views };
    const generated = await generateAllViews(body);
    const composition = await composeMultiView(generated, body.resolution);
    const baseView: ViewId = generated[0]?.id;

    if (!composition?.buffer) {
      throw new Error('Generation returned no combinedImage');
    }

    const combinedImage = `data:image/png;base64,${composition.buffer.toString('base64')}`;
    const response: GenerateResponseBody = {
      combinedImage,
      views: generated.map((g) => ({
        view: g.id,
        image: `data:image/png;base64,${g.buffer.toString('base64')}`,
      })),
      meta: {
        baseView,
        style: body.style,
        resolution: body.resolution,
      },
    };

    console.log('[server] Generation successful');

    return res.json(response);
  } catch (err: any) {
    console.error('[server] GENERATION CRASH:', err.stack || err);

    return res.status(500).json({
      error: err.message || 'Unknown server error',
    });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'build', 'index.html'));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API server running on http://localhost:${PORT}`);
});

