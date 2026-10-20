import { config } from './config.js';

const auth = [{ bearerAuth: [] }, { humanSession: [] }];
const projectHash = parameter('projectHash', 'path', true, { type: 'string' }, 'Opaque project hash supplied by the owner');
const fileId = parameter('fileId', 'path', true, { type: 'string', format: 'uuid' });
const revisionId = parameter('revisionId', 'path', true, { type: 'string', format: 'uuid' });
const jobId = parameter('jobId', 'path', true, { type: 'string', format: 'uuid' });
const ifMatch = parameter('If-Match', 'header', true, { type: 'string' }, 'Current revision from GET/ETag');
const error = (description = 'Request failed') => response(description, 'ErrorEnvelope');
const binary = (description: string, contentType: string) => ({
  description,
  content: { [contentType]: { schema: { type: 'string', format: 'binary' } } }
});

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Overroot Agent API',
    version: '0.1.0',
    description:
      'Project-scoped, revision-safe REST access. Agents use a scoped Bearer token independently of shared human accounts. Humans use a host-only HttpOnly cookie after central authorization-code/PKCE sign-in. Every human API request introspects its central grant; outages return 503. Cookie-authenticated mutations require Origin matching the app origin. Send If-Match when mutating existing files.'
  },
  externalDocs: {
    description: 'Agent guide',
    url: `${config.publicUrl}/agent-guide.md`
  },
  servers: [{ url: config.publicUrl, description: 'Overroot frontend and API' }],
  security: auth,
  tags: [{ name: 'Agent' }, { name: 'Projects' }, { name: 'Files' }, { name: 'Compile' }],
  paths: {
    '/api/v1/status': {
      get: { operationId: 'getStatus', security: [], responses: { '200': response('Backend status', 'Status') } }
    },
    '/api/v1/auth/start': {
      get: { operationId: 'startHumanSignIn', security: [], parameters: [parameter('returnTo', 'query', false, { type: 'string' }, 'App-local /#/ path; all other values become /#/')], responses: { '302': { description: 'Redirect to the fixed accounts issuer with state and S256 PKCE; sets a 120-second host-only login cookie' }, '503': error('Identity migration required') } }
    },
    '/api/v1/auth/callback': {
      get: { operationId: 'completeHumanSignIn', security: [], parameters: [parameter('state', 'query', true, { type: 'string' }), parameter('code', 'query', true, { type: 'string' })], responses: { '302': { description: 'Consumes browser-bound state, exchanges the single-use code with confidential client authentication, sets __Host-overroot_session, and redirects locally. No browser bearer token.' }, '400': error('Invalid or expired sign-in attempt'), '503': error('Accounts unavailable') } }
    },
    '/api/v1/auth/account': {
      get: { operationId: 'openSharedAccount', security: [], responses: { '302': { description: 'Redirect to central account controls, signup and password settings' } } }
    },
    '/api/v1/auth/me': {
      get: { operationId: 'getHumanAccount', security: [{ humanSession: [] }], responses: { '200': response('Local identity projection and Overroot permissions', 'UserEnvelope'), '401': error(), '503': error('Accounts unavailable') } }
    },
    '/api/v1/auth/logout': {
      post: { operationId: 'logoutHuman', security: [{ humanSession: [] }], responses: { '204': { description: 'Revokes the central app grant, deletes the app session, clears its cookie and closes local sockets' }, '401': error(), '403': error('Exact app Origin required'), '503': error('Accounts unavailable; retry logout') } }
    },
    '/api/v1/agent/context': {
      get: {
        operationId: 'getAgentContext', security: [{ bearerAuth: [] }], tags: ['Agent'],
        responses: { '200': response('Credential scope and capabilities', 'AgentContext'), '401': error() }
      }
    },
    '/api/v1/projects/{projectHash}': {
      get: {
        operationId: 'getProject', tags: ['Projects'], parameters: [projectHash],
        responses: { '200': response('Project metadata', 'ProjectEnvelope'), '404': error('Project not found') }
      }
    },
    '/api/v1/projects/{projectHash}/files': {
      get: {
        operationId: 'listFiles', tags: ['Files'], parameters: [projectHash],
        responses: { '200': response('Project file tree', 'FileListEnvelope'), '404': error() }
      },
      post: {
        operationId: 'createFile', tags: ['Files'], parameters: [projectHash],
        requestBody: jsonBody('CreateFile'),
        responses: { '201': response('File created', 'FileEnvelope'), '409': error('Path already exists'), '413': error('File too large') }
      }
    },
    '/api/v1/projects/{projectHash}/files/{fileId}': {
      get: {
        operationId: 'getFile', tags: ['Files'], parameters: [projectHash, fileId],
        responses: { '200': withEtag(response('File content and current revision', 'FileEnvelope')), '404': error() }
      },
      put: {
        operationId: 'replaceFile', tags: ['Files'], parameters: [projectHash, fileId, ifMatch],
        requestBody: jsonBody('FileContent'),
        responses: mutationResponses('FileEnvelope')
      },
      patch: {
        operationId: 'renameFile', tags: ['Files'], parameters: [projectHash, fileId, ifMatch],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } } }
        },
        responses: mutationResponses('FileEnvelope')
      },
      delete: {
        operationId: 'deleteFile', tags: ['Files'], parameters: [projectHash, fileId, ifMatch],
        responses: { '204': { description: 'File deleted' }, '409': error('Revision conflict'), '428': error('If-Match required') }
      }
    },
    '/api/v1/projects/{projectHash}/files/{fileId}/raw': {
      get: {
        operationId: 'downloadRawFile', tags: ['Files'], parameters: [projectHash, fileId],
        responses: { '200': withEtag(binary('Raw file bytes', 'application/octet-stream')), '404': error() }
      }
    },
    '/api/v1/projects/{projectHash}/files/{fileId}/revisions': {
      get: {
        operationId: 'listFileRevisions', tags: ['Files'], parameters: [projectHash, fileId],
        responses: { '200': response('Latest 200 revisions', 'RevisionListEnvelope'), '404': error() }
      }
    },
    '/api/v1/projects/{projectHash}/files/{fileId}/revisions/{revisionId}': {
      get: {
        operationId: 'getFileRevision', tags: ['Files'], parameters: [projectHash, fileId, revisionId],
        responses: { '200': response('Historical content', 'RevisionEnvelope'), '404': error() }
      }
    },
    '/api/v1/projects/{projectHash}/files/{fileId}/revisions/{revisionId}/restore': {
      post: {
        operationId: 'restoreFileRevision', tags: ['Files'], parameters: [projectHash, fileId, revisionId, ifMatch],
        responses: mutationResponses('FileEnvelope')
      }
    },
    '/api/v1/projects/{projectHash}/compile': {
      post: {
        operationId: 'startCompile', tags: ['Compile'], parameters: [projectHash],
        responses: {
          '200': response('Cached result', 'CompileEnvelope'),
          '202': response('Compile queued', 'CompileEnvelope'),
          '400': error('Entry file missing'),
          '413': error('Project exceeds the compiler snapshot byte limit'),
          '429': error('Compiler queue capacity is full; retry after a pending job finishes')
        }
      }
    },
    '/api/v1/projects/{projectHash}/compile/latest': {
      get: {
        operationId: 'getLatestCompile', tags: ['Compile'], parameters: [projectHash],
        responses: { '200': response('Latest project compile, if any', 'NullableCompileEnvelope') }
      }
    },
    '/api/v1/projects/{projectHash}/compile/{jobId}': {
      get: {
        operationId: 'getCompileJob', tags: ['Compile'], parameters: [projectHash, jobId],
        responses: { '200': response('Specific compile status and log', 'CompileEnvelope'), '404': error() }
      }
    },
    '/api/v1/projects/{projectHash}/compile/{jobId}/pdf': {
      get: {
        operationId: 'downloadCompiledPdf', tags: ['Compile'], parameters: [projectHash, jobId],
        responses: { '200': binary('Immutable PDF for this job', 'application/pdf'), '404': error() }
      }
    },
    '/api/v1/projects/{projectHash}/compile/{jobId}/synctex': {
      get: {
        operationId: 'locateSourceInPdf', tags: ['Compile'],
        parameters: [
          projectHash,
          jobId,
          parameter('path', 'query', true, { type: 'string' }, 'Project-relative source path'),
          parameter('line', 'query', true, { type: 'integer', minimum: 1 }, 'One-based source line')
        ],
        responses: { '200': response('PDF highlight geometry for a source line', 'SyncTexEnvelope'), '404': error() }
      }
    },
    '/api/v1/projects/{projectHash}/pdf': {
      get: {
        operationId: 'downloadLatestPdf', tags: ['Compile'], parameters: [projectHash],
        responses: { '200': withEtag(binary('Latest successful PDF', 'application/pdf')), '404': error() }
      }
    },
    '/api/v1/projects/{projectHash}/export.zip': {
      get: {
        operationId: 'exportProject', tags: ['Projects'], parameters: [projectHash],
        responses: { '200': binary('Project source archive', 'application/zip') }
      }
    }
  },
  components: {
    securitySchemes: {
      humanSession: { type: 'apiKey', in: 'cookie', name: '__Host-overroot_session', description: 'Secure; HttpOnly; SameSite=Lax; Path=/; no Domain. Validated centrally on every API request. Agent Authorization headers take precedence.' },
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'Overroot project agent password' }
    },
    schemas: {
      UserEnvelope: { type: 'object', required: ['user'], properties: { user: { type: 'object', required: ['id', 'username', 'displayName', 'isAdmin', 'createdAt'], properties: { id: { type: 'string' }, username: { type: 'string' }, displayName: { type: 'string' }, isAdmin: { type: 'boolean', description: 'Overroot-local grant, never inferred from central approval' }, createdAt: { type: 'string' } } } } },
      ErrorEnvelope: {
        type: 'object', required: ['error'], properties: {
          error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } }
        }
      },
      Status: {
        type: 'object', required: ['ok', 'name', 'version', 'identityOrigin', 'publicUrl', 'serverTime'], properties: {
          ok: { type: 'boolean' }, name: { type: 'string' }, version: { type: 'string' },
          identityOrigin: { type: 'string', format: 'uri' }, publicUrl: { type: 'string', format: 'uri' }, serverTime: { type: 'string', format: 'date-time' }
        }
      },
      Project: {
        type: 'object', required: ['hash', 'name', 'entryFile', 'owner', 'role', 'canWrite', 'canManage', 'memberCount', 'createdAt', 'updatedAt'], properties: {
          hash: { type: 'string' }, name: { type: 'string' }, entryFile: { type: 'string' }, owner: { type: 'string' },
          role: { enum: ['owner', 'editor', 'viewer', 'agent'] }, canWrite: { type: 'boolean' }, canManage: { type: 'boolean' },
          memberCount: { type: 'integer' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }, latestCompile: { oneOf: [{ $ref: '#/components/schemas/CompileSummary' }, { type: 'null' }] }
        }
      },
      ProjectEnvelope: envelope('project', 'Project'),
      ProjectFile: {
        type: 'object', required: ['id', 'path', 'kind', 'mimeType', 'revision', 'size', 'createdAt', 'updatedAt'], properties: {
          id: { type: 'string', format: 'uuid' }, path: { type: 'string' }, kind: { enum: ['text', 'binary'] }, mimeType: { type: 'string' },
          revision: { type: 'string' }, size: { type: 'integer' }, content: { type: 'string' }, contentBase64: { type: 'string', contentEncoding: 'base64' },
          createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' }
        }
      },
      FileEnvelope: envelope('file', 'ProjectFile'),
      FileListEnvelope: { type: 'object', required: ['files'], properties: { files: { type: 'array', items: { $ref: '#/components/schemas/ProjectFile' } } } },
      CreateFile: {
        type: 'object', required: ['path'], oneOf: [{ required: ['content'] }, { required: ['contentBase64'] }], properties: {
          path: { type: 'string' }, content: { type: 'string' }, contentBase64: { type: 'string', contentEncoding: 'base64' }, mimeType: { type: 'string' }
        }
      },
      FileContent: {
        type: 'object', oneOf: [{ required: ['content'] }, { required: ['contentBase64'] }], properties: {
          content: { type: 'string' }, contentBase64: { type: 'string', contentEncoding: 'base64' }
        }
      },
      FileRevision: {
        type: 'object', required: ['id', 'revision', 'actorType', 'actorId', 'actorName', 'createdAt'], properties: {
          id: { type: 'string', format: 'uuid' }, revision: { type: 'string' }, actorType: { enum: ['user', 'agent', 'system'] }, actorId: { type: 'string' }, actorName: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' }, size: { type: 'integer' }, content: { type: 'string' }, contentBase64: { type: 'string', contentEncoding: 'base64' }
        }
      },
      RevisionEnvelope: envelope('revision', 'FileRevision'),
      RevisionListEnvelope: { type: 'object', required: ['revisions'], properties: { revisions: { type: 'array', items: { $ref: '#/components/schemas/FileRevision' } } } },
      Actor: { type: 'object', required: ['type', 'id', 'name'], properties: { type: { enum: ['user', 'agent', 'system'] }, id: { type: 'string' }, name: { type: 'string' } } },
      CompileSummary: { type: 'object', required: ['id', 'status', 'hasPdf'], properties: { id: { type: 'string', format: 'uuid' }, status: { $ref: '#/components/schemas/CompileStatus' }, finishedAt: { type: ['string', 'null'], format: 'date-time' }, hasPdf: { type: 'boolean' } } },
      CompileStatus: { enum: ['queued', 'compiling', 'succeeded', 'failed', 'cancelled'] },
      CompileJob: {
        type: 'object', required: ['id', 'sourceHash', 'status', 'entryFile', 'log', 'requestedBy', 'createdAt', 'hasPdf', 'hasSynctex'], properties: {
          id: { type: 'string', format: 'uuid' }, sourceHash: { type: 'string' }, status: { $ref: '#/components/schemas/CompileStatus' }, entryFile: { type: 'string' }, log: { type: 'string' }, error: { type: ['string', 'null'] }, requestedBy: { $ref: '#/components/schemas/Actor' },
          createdAt: { type: 'string', format: 'date-time' }, startedAt: { type: ['string', 'null'], format: 'date-time' }, finishedAt: { type: ['string', 'null'], format: 'date-time' }, hasPdf: { type: 'boolean' }, hasSynctex: { type: 'boolean' }
        }
      },
      CompileEnvelope: envelope('job', 'CompileJob'),
      NullableCompileEnvelope: { type: 'object', required: ['job', 'lastSuccessfulJob'], properties: {
        job: { oneOf: [{ $ref: '#/components/schemas/CompileJob' }, { type: 'null' }] },
        lastSuccessfulJob: { description: 'Last successful compile for restoring the PDF independently of the latest attempt status.', oneOf: [{ $ref: '#/components/schemas/CompileJob' }, { type: 'null' }] }
      } },
      SyncTexHighlight: {
        type: 'object', required: ['page', 'x', 'y', 'width', 'height'], properties: {
          page: { type: 'integer', minimum: 1 }, x: { type: 'number' }, y: { type: 'number' },
          width: { type: 'number' }, height: { type: 'number' }
        }
      },
      SyncTexEnvelope: {
        type: 'object', required: ['source', 'highlights'], properties: {
          source: {
            type: 'object', required: ['path', 'line', 'mappedLine'], properties: {
              path: { type: 'string' }, line: { type: 'integer' }, mappedLine: { type: ['integer', 'null'] }
            }
          },
          highlights: { type: 'array', items: { $ref: '#/components/schemas/SyncTexHighlight' } }
        }
      },
      AgentContext: {
        type: 'object', required: ['project', 'capabilities', 'concurrency', 'openapi'], properties: {
          project: { $ref: '#/components/schemas/Project' }, capabilities: { type: 'array', items: { type: 'string' } },
          concurrency: { type: 'object', required: ['mutationsRequireIfMatch', 'conflictStatus'], properties: { mutationsRequireIfMatch: { type: 'boolean' }, conflictStatus: { type: 'integer' } } }, openapi: { type: 'string' }
        }
      }
    }
  }
} as const;

function parameter(name: string, location: string, required: boolean, schema: object, description?: string) {
  return { name, in: location, required, schema, ...(description ? { description } : {}) };
}

function response(description: string, schemaName: string) {
  return { description, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } } };
}

function withEtag<T extends object>(value: T) {
  return { ...value, headers: { ETag: { description: 'Current revision', schema: { type: 'string' } } } };
}

function jsonBody(schemaName: string) {
  return { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } } };
}

function mutationResponses(schemaName: string) {
  return {
    '200': withEtag(response('Mutation applied and broadcast to collaborators', schemaName)),
    '409': error('Revision conflict; fetch and merge before retrying'),
    '428': error('If-Match is required for agent mutations')
  };
}

function envelope(property: string, schemaName: string) {
  return { type: 'object', required: [property], properties: { [property]: { $ref: `#/components/schemas/${schemaName}` } } };
}
