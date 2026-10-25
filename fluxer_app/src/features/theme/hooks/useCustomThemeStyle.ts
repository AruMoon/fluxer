// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import {clearRemScaleCache} from '@app/features/theme/layout/RemFromPx';
import type {ThemeLibraryAsset, ThemeLibraryLocalFileReference} from '@app/features/theme/state/ThemeLibrary';
import {resolveThemeCssReferences} from '@app/features/theme/utils/ThemeCssUtils';
import {useEffect} from 'react';

export const CUSTOM_THEME_STYLE_ELEMENT_ID = 'fluxer-custom-theme-style';
export const INSTANCE_CUSTOM_CSS_ELEMENT_ID = 'fluxer-instance-custom-css';
const logger = new Logger('useCustomThemeStyle');

interface CustomThemeStyleOptions {
	enabledThemeCss: string | null | undefined;
	customThemeCss: string | null | undefined;
	themeLibraryAssets: ReadonlyArray<ThemeLibraryAsset>;
	themeLibraryLocalFiles: ReadonlyArray<ThemeLibraryLocalFileReference>;
	themeLibraryRevision: number;
	onMissingReferences: (references: ReadonlyArray<string>) => void;
}

export function useInstanceCustomCss(instanceCss: string | null): void {
	useEffect(() => {
		const css = instanceCss?.trim() ?? '';
		const existing = document.getElementById(INSTANCE_CUSTOM_CSS_ELEMENT_ID);
		if (!css) {
			if (existing) {
				existing.remove();
				clearRemScaleCache();
			}
			return;
		}
		const styleElement = existing ?? document.createElement('style');
		styleElement.id = INSTANCE_CUSTOM_CSS_ELEMENT_ID;
		styleElement.textContent = css;
		if (!existing) {
			document.head.insertBefore(styleElement, document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID));
		}
		clearRemScaleCache();
	}, [instanceCss]);
}

export function useCustomThemeStyle({
	enabledThemeCss,
	customThemeCss,
	themeLibraryAssets,
	themeLibraryLocalFiles,
	themeLibraryRevision,
	onMissingReferences,
}: CustomThemeStyleOptions): void {
	useEffect(() => {
		const existing = document.getElementById(CUSTOM_THEME_STYLE_ELEMENT_ID) as HTMLStyleElement | null;
		const css = [enabledThemeCss, customThemeCss]
			.map((value) => value?.trim() ?? '')
			.filter(Boolean)
			.join('\n\n');
		if (!css) {
			onMissingReferences([]);
			if (existing?.parentNode) {
				existing.parentNode.removeChild(existing);
				clearRemScaleCache();
			}
			return;
		}
		const styleElement = existing ?? document.createElement('style');
		const applyThemeCss = (value: string): void => {
			styleElement.textContent = value;
			clearRemScaleCache();
		};
		styleElement.id = CUSTOM_THEME_STYLE_ELEMENT_ID;
		let disposed = false;
		let objectUrls: Array<string> = [];
		void resolveThemeCssReferences(css, themeLibraryAssets, themeLibraryLocalFiles)
			.then((resolved) => {
				if (disposed) {
					for (const objectUrl of resolved.objectUrls) {
						URL.revokeObjectURL(objectUrl);
					}
					return;
				}
				objectUrls = resolved.objectUrls;
				applyThemeCss(resolved.css);
				onMissingReferences([...resolved.missingAssetReferences, ...resolved.missingLocalFileReferences]);
				if (resolved.missingAssetReferences.length > 0 || resolved.missingLocalFileReferences.length > 0) {
					logger.warn('Custom theme CSS has unresolved file references', {
						assets: resolved.missingAssetReferences,
						localFiles: resolved.missingLocalFileReferences,
					});
				}
			})
			.catch((error) => {
				logger.error('Failed to resolve custom theme CSS references', error);
				applyThemeCss(css);
			});
		if (!existing) {
			document.head.appendChild(styleElement);
		}
		return () => {
			disposed = true;
			for (const objectUrl of objectUrls) {
				URL.revokeObjectURL(objectUrl);
			}
		};
	}, [
		customThemeCss,
		enabledThemeCss,
		themeLibraryAssets,
		themeLibraryLocalFiles,
		themeLibraryRevision,
		onMissingReferences,
	]);
}
