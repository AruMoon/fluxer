// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import ThemeLibrary, {getThemeLabel} from '@app/features/theme/state/ThemeLibrary';
import ThemeSettingsState from '@app/features/theme_settings/state/ThemeSettingsState';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const DISCARD_CHANGES_DESCRIPTOR = msg({
	message: 'Discard changes to {themeName}?',
	comment: 'Confirmation title in the quick CSS editor window before leaving a theme with unsaved changes.',
});
const DISCARD_DESCRIPTOR = msg({
	message: 'Discard',
	comment: 'Confirm button that throws away unsaved changes to a theme in the quick CSS editor window.',
});
const UNSAVED_CHANGES_DESCRIPTION_DESCRIPTOR = msg({
	message: "Your changes to this theme haven't been saved.",
	comment: 'Confirmation text in the quick CSS editor window before leaving a theme with unsaved changes.',
});
export function confirmDiscardThemeChanges(
	i18n: I18n,
	portalHost: HTMLElement | null,
	themeName: string,
	onDiscard: () => void,
): void {
	const render = modal(() => (
		<ConfirmModal
			title={i18n._(DISCARD_CHANGES_DESCRIPTOR, {themeName})}
			description={i18n._(UNSAVED_CHANGES_DESCRIPTION_DESCRIPTOR)}
			primaryText={i18n._(DISCARD_DESCRIPTOR)}
			primaryVariant="danger"
			secondaryText={i18n._(CANCEL_DESCRIPTOR)}
			onPrimary={onDiscard}
			data-flx="theme-settings.quick-css-editor-discard.confirm-discard-theme-changes.confirm-modal"
		/>
	));
	if (portalHost) {
		ModalCommands.pushToPortalHost({modal: render, portalHost});
		return;
	}
	ModalCommands.push(render);
}

export function requestQuickCssEditorClose(i18n: I18n, close: () => void): void {
	if (!ThemeSettingsState.editorDirty) {
		close();
		return;
	}
	const theme = ThemeLibrary.themes.find((candidate) => candidate.id === ThemeSettingsState.editorFile);
	confirmDiscardThemeChanges(i18n, null, theme ? getThemeLabel(theme) : '', close);
}
