// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserSettingsModal} from '@app/features/app/components/dialogs/LoadableSettingsModals';
import {ComponentBus} from '@app/features/platform/utils/ComponentBus';
import * as ThemeProfileCommands from '@app/features/theme/commands/ThemeProfileCommands';
import ThemeEditTarget from '@app/features/theme/state/ThemeEditTarget';
import ThemeSettingsState, {QUICK_CSS_EDITOR_FILE} from '@app/features/theme_settings/state/ThemeSettingsState';
import {quickCssEditorNeedsDesktopUpdate} from '@app/features/theme_settings/utils/QuickCssEditorSupport';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import ModalState from '@app/features/ui/state/Modal';
import {getElectronAPI} from '@app/features/ui/utils/NativeUtils';

export const QUICK_CSS_EDITOR_WINDOW_KEY = 'fluxer_quick_css_editor';

export function setEditedCustomThemeCss(css: string | null): void {
	ThemeProfileCommands.setCustomThemeCss(css, ThemeEditTarget.target);
}

export function canOpenQuickCssEditor(): boolean {
	return !MobileLayout.enabled && !quickCssEditorNeedsDesktopUpdate();
}

function focusQuickCssEditor(): void {
	ThemeSettingsState.editorWindow?.focus();
	void getElectronAPI()?.popoutFocus?.(QUICK_CSS_EDITOR_WINDOW_KEY);
}

export function openQuickCssEditor(file: string = QUICK_CSS_EDITOR_FILE): void {
	if (!canOpenQuickCssEditor()) return;
	const wasOpen = ThemeSettingsState.editorOpen;
	ThemeSettingsState.openEditor(file);
	if (wasOpen) focusQuickCssEditor();
}

export function focusOrOpenQuickCssEditor(): void {
	if (!canOpenQuickCssEditor()) return;
	if (ThemeSettingsState.editorOpen) {
		focusQuickCssEditor();
		return;
	}
	ThemeSettingsState.openEditor(QUICK_CSS_EDITOR_FILE);
}

export function openThemesSettings(): void {
	if (ModalState.hasModalOfModalType('user-settings')) {
		ComponentBus.dispatch('USER_SETTINGS_TAB_SELECT', {tab: 'themes'});
		return;
	}
	ModalCommands.push(
		modal(
			() => (
				<UserSettingsModal
					initialTab="themes"
					data-flx="theme-settings.theme-settings-commands.open-themes-settings.user-settings-modal"
				/>
			),
			'user-settings',
		),
	);
}
