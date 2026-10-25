// SPDX-License-Identifier: AGPL-3.0-or-later

import AppStorage from '@app/features/platform/state/PersistentStorage';
import {makeAutoObservable} from 'mobx';

const EXPANDED_GROUPS_STORAGE_KEY = 'ThemeStudio:expandedGroups';

export const QUICK_CSS_EDITOR_FILE = 'quick-css';

function readStoredExpandedGroups(): Array<string> {
	try {
		const raw = AppStorage.getItem(EXPANDED_GROUPS_STORAGE_KEY);
		if (raw === null) return [];
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
			return parsed;
		}
	} catch {}
	return [];
}

class ThemeSettingsState {
	librarySearch = '';
	tokenSearch = '';
	expandedGroups: ReadonlySet<string> = new Set(readStoredExpandedGroups());
	editorOpen = false;
	editorGeneration = 0;
	editorFile: string = QUICK_CSS_EDITOR_FILE;
	editorDirty = false;
	missingReferences: ReadonlyArray<string> = [];
	editorWindow: Window | null = null;
	editorFileRequestHandler: ((file: string) => void) | null = null;

	constructor() {
		makeAutoObservable(this, {editorWindow: false, editorFileRequestHandler: false}, {autoBind: true});
	}

	setLibrarySearch(value: string): void {
		this.librarySearch = value;
	}

	setTokenSearch(value: string): void {
		this.tokenSearch = value;
	}

	isGroupExpanded(groupId: string): boolean {
		return this.expandedGroups.has(groupId);
	}

	setGroupExpanded(groupId: string, expanded: boolean): void {
		const next = new Set(this.expandedGroups);
		if (expanded) {
			next.add(groupId);
		} else {
			next.delete(groupId);
		}
		this.expandedGroups = next;
		try {
			AppStorage.setItem(EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify([...next]));
		} catch {}
	}

	openEditor(file: string): void {
		if (this.editorOpen) {
			this.requestEditorFile(file);
			return;
		}
		this.editorFile = file;
		this.editorDirty = false;
		this.editorGeneration += 1;
		this.editorOpen = true;
	}

	requestEditorFile(file: string): void {
		if (file === this.editorFile) return;
		if (this.editorFileRequestHandler) {
			this.editorFileRequestHandler(file);
			return;
		}
		this.setEditorFile(file);
	}

	setEditorFile(file: string): void {
		this.editorFile = file;
		this.editorDirty = false;
	}

	setEditorFileRequestHandler(handler: ((file: string) => void) | null): void {
		this.editorFileRequestHandler = handler;
	}

	setEditorDirty(dirty: boolean): void {
		this.editorDirty = dirty;
	}

	setEditorWindow(editorWindow: Window | null): void {
		this.editorWindow = editorWindow;
	}

	closeEditor(generation: number): void {
		if (generation !== this.editorGeneration) return;
		this.editorOpen = false;
		this.editorWindow = null;
		this.editorFile = QUICK_CSS_EDITOR_FILE;
		this.editorDirty = false;
	}

	setMissingReferences(references: ReadonlyArray<string>): void {
		this.missingReferences = references;
	}
}

export default new ThemeSettingsState();
