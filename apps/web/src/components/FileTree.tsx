import { ChevronDown, ChevronRight, File, FileCode2, FileImage, FilePlus2, Folder, FolderOpen, MoreHorizontal, Upload } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { ProjectFile } from '../types';

interface TreeNode {
  name: string;
  path: string;
  folders: TreeNode[];
  files: ProjectFile[];
}

export function FileTree({
  files,
  selectedId,
  canWrite,
  onSelect,
  onCreate,
  onUpload,
  onFileMenu
}: {
  files: ProjectFile[];
  selectedId: string | null;
  canWrite: boolean;
  onSelect: (file: ProjectFile) => void;
  onCreate: () => void;
  onUpload: (files: FileList) => void;
  onFileMenu: (file: ProjectFile) => void;
}) {
  const root = useMemo(() => makeTree(files), [files]);
  const input = useRef<HTMLInputElement>(null);
  return (
    <aside className="file-tree" aria-label="Project files">
      <div className="file-tree__head">
        <span>Files <b>{files.length}</b></span>
        {canWrite && <div>
          <button className="icon-button" type="button" onClick={onCreate} aria-label="Create file" title="Create file"><FilePlus2 size={15}/></button>
          <button className="icon-button" type="button" onClick={() => input.current?.click()} aria-label="Upload files" title="Upload files"><Upload size={15}/></button>
          <input ref={input} hidden type="file" multiple onChange={(event) => {
            if (event.target.files?.length) onUpload(event.target.files);
            event.target.value = '';
          }}/>
        </div>}
      </div>
      <nav className="file-tree__scroll">
        {files.length === 0 ? <div className="tree-empty">No files</div> : <TreeLevel node={root} depth={0} {...{ selectedId, canWrite, onSelect, onFileMenu }}/>}
      </nav>
    </aside>
  );
}

function TreeLevel({
  node,
  depth,
  selectedId,
  canWrite,
  onSelect,
  onFileMenu
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  canWrite: boolean;
  onSelect: (file: ProjectFile) => void;
  onFileMenu: (file: ProjectFile) => void;
}) {
  return <>
    {node.folders.map((folder) => <FolderRow key={folder.path} folder={folder} depth={depth} {...{ selectedId, canWrite, onSelect, onFileMenu }}/>) }
    {node.files.map((file) => {
      const Icon = iconFor(file);
      return <div key={file.id} className={`tree-file ${selectedId === file.id ? 'is-active' : ''}`} style={{ '--depth': depth } as React.CSSProperties}>
        <button type="button" className="tree-file__select" onClick={() => onSelect(file)} title={file.path}>
          <Icon size={14} strokeWidth={1.6}/><span>{file.path.split('/').at(-1)}</span>
        </button>
        {canWrite && <button type="button" className="tree-file__menu" onClick={() => onFileMenu(file)} aria-label={`Actions for ${file.path}`}><MoreHorizontal size={14}/></button>}
      </div>;
    })}
  </>;
}

function FolderRow({ folder, depth, ...props }: { folder: TreeNode; depth: number } & Omit<Parameters<typeof TreeLevel>[0], 'node' | 'depth'>) {
  const [open, setOpen] = useState(true);
  return <div className="tree-folder">
    <button type="button" className="tree-folder__row" style={{ '--depth': depth } as React.CSSProperties} onClick={() => setOpen(!open)} aria-expanded={open}>
      {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}{open ? <FolderOpen size={14}/> : <Folder size={14}/>}<span>{folder.name}</span>
    </button>
    {open && <TreeLevel node={folder} depth={depth + 1} {...props}/>} 
  </div>;
}

function makeTree(files: ProjectFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: [], files: [] };
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split('/');
    let node = root;
    parts.slice(0, -1).forEach((part) => {
      let folder = node.folders.find((entry) => entry.name === part);
      if (!folder) {
        folder = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: [], files: [] };
        node.folders.push(folder);
      }
      node = folder;
    });
    node.files.push(file);
  }
  return root;
}

function iconFor(file: ProjectFile) {
  if (file.kind === 'binary' && file.mimeType.startsWith('image/')) return FileImage;
  if (/\.(tex|bib|sty|cls|tikz)$/i.test(file.path)) return FileCode2;
  return File;
}
