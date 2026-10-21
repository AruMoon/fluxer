// SPDX-License-Identifier: AGPL-3.0-or-later

import {createNamedLoadableComponent} from '@app/features/platform/components/loadable/LoadableComponent';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {
	CUSTOM_THEME_STYLE_ELEMENT_ID,
	INSTANCE_CUSTOM_CSS_ELEMENT_ID,
} from '@app/features/theme/hooks/useCustomThemeStyle';
import ThemeLibrary, {getThemeLabel} from '@app/features/theme/state/ThemeLibrary';
import {QUICK_CSS_EDITOR_WINDOW_KEY} from '@app/features/theme_settings/commands/ThemeSettingsCommands';
import {requestQuickCssEditorClose} from '@app/features/theme_settings/components/QuickCssEditorDiscard';
import ThemeSettingsState, {QUICK_CSS_EDITOR_FILE} from '@app/features/theme_settings/state/ThemeSettingsState';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {PopoutWindow} from '@app/features/ui/popout_window/PopoutWindow';
import type {StylesheetMirrorOptions} from '@app/features/ui/popout_window/PopoutWindowDocument';
import {getElectronAPI, isDesktop} from '@app/features/ui/utils/NativeUtils';
import {QUICK_CSS_SECTION_DESCRIPTOR} from '@app/features/user/components/settings_utils/section_registry/ThemesSections';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';

const logger = new Logger('QuickCssEditorWindowHost');

const POPUP_BLOCKED_DESCRIPTOR = msg({
	message: 'Your browser blocked the editor window. Allow pop-ups for this site and try again.',
	comment: 'Toast on the web app when the browser blocks the quick CSS editor window from opening.',
});

const EDITOR_WINDOW_WIDTH = 960;
const EDITOR_WINDOW_HEIGHT = 720;
const USER_STYLE_ELEMENT_IDS: ReadonlySet<string> = new Set([
	CUSTOM_THEME_STYLE_ELEMENT_ID,
	INSTANCE_CUSTOM_CSS_ELEMENT_ID,
]);
const STYLESHEET_MIRROR: StylesheetMirrorOptions = {
	exclude: (node) => USER_STYLE_ELEMENT_IDS.has(node.id),
};

const QuickCssEditorWindowContent = createNamedLoadableComponent<Record<string, never>>({
	displayName: 'QuickCssEditorWindow',
	load: async () => (await import('@app/features/theme_settings/components/QuickCssEditorWindow')).QuickCssEditorWindow,
});

const OpenQuickCssEditorWindow: React.FC = observer(() => {
	const {i18n} = useLingui();
	const generation = ThemeSettingsState.editorGeneration;
	const openedGenerationRef = useRef<number | null>(null);
	const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(isDesktop());
	const theme =
		ThemeSettingsState.editorFile === QUICK_CSS_EDITOR_FILE
			? null
			: ThemeLibrary.themes.find((candidate) => candidate.id === ThemeSettingsState.editorFile);
	const title = theme ? getThemeLabel(theme) : i18n._(QUICK_CSS_SECTION_DESCRIPTOR);
	useEffect(() => {
		const closeWithMainWindow = (): void => ThemeSettingsState.editorWindow?.close();
		window.addEventListener('pagehide', closeWithMainWindow);
		return () => {
			window.removeEventListener('pagehide', closeWithMainWindow);
			ThemeSettingsState.closeEditor(generation);
		};
	}, [generation]);
	const handleWindowOpened = useCallback((childWindow: Window, windowGeneration: number) => {
		openedGenerationRef.current = windowGeneration;
		ThemeSettingsState.setEditorWindow(childWindow);
	}, []);
	const handleClosed = useCallback(
		(windowGeneration: number) => {
			if (openedGenerationRef.current !== windowGeneration) {
				ToastCommands.error(i18n._(POPUP_BLOCKED_DESCRIPTOR));
			}
			ThemeSettingsState.closeEditor(windowGeneration);
		},
		[i18n],
	);
	const handleCloseRequest = useCallback(
		(close: () => void) => {
			requestQuickCssEditorClose(i18n, close);
		},
		[i18n],
	);
	const electronApi = getElectronAPI();
	const handleToggleAlwaysOnTop = useCallback(() => {
		const next = !isAlwaysOnTop;
		void getElectronAPI()
			?.popoutSetAlwaysOnTop?.(QUICK_CSS_EDITOR_WINDOW_KEY, next)
			.then((changed) => {
				if (changed) setIsAlwaysOnTop(next);
			})
			.catch((error) => logger.warn('Failed to toggle the quick CSS editor always-on-top', error));
	}, [isAlwaysOnTop]);
	return (
		<PopoutWindow
			windowKey={QUICK_CSS_EDITOR_WINDOW_KEY}
			windowGeneration={generation}
			title={title}
			width={EDITOR_WINDOW_WIDTH}
			height={EDITOR_WINDOW_HEIGHT}
			isAlwaysOnTop={isAlwaysOnTop}
			onToggleAlwaysOnTop={electronApi?.popoutSetAlwaysOnTop ? handleToggleAlwaysOnTop : undefined}
			onClosed={handleClosed}
			onCloseRequest={handleCloseRequest}
			onWindowOpened={handleWindowOpened}
			stylesheetMirror={STYLESHEET_MIRROR}
			data-flx="theme-settings.quick-css-editor-window-host.open-quick-css-editor-window.popout-window"
		>
			<QuickCssEditorWindowContent data-flx="theme-settings.quick-css-editor-window-host.open-quick-css-editor-window.quick-css-editor-window-content" />
		</PopoutWindow>
	);
});

export const QuickCssEditorWindowHost: React.FC = observer(() => {
	if (!ThemeSettingsState.editorOpen) {
		return null;
	}
	return (
		<OpenQuickCssEditorWindow
			key={ThemeSettingsState.editorGeneration}
			data-flx="theme-settings.quick-css-editor-window-host.open-quick-css-editor-window"
		/>
	);
});
