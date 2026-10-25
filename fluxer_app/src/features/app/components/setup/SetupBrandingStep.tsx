// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	brandingAssetPolicyKind,
	brandingAssetUrl,
	useSetupBrandingDraft,
	validateBrandingFile,
} from '@app/features/app/components/setup/SetupBrandingDraft';
import {BrandingFields} from '@app/features/app/components/setup/SetupBrandingFields';
import {
	type SetupBrandingAssetKind,
	type updateInstanceConfig,
	uploadBrandingAsset,
} from '@app/features/app/components/setup/SetupWizardClient';
import {openFilePicker} from '@app/features/messaging/utils/FilePickerUtils';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {readBlobAsDataUrl as fileToBase64} from '@app/features/platform/utils/BlobDataUrl';
import {int2hex} from '@app/features/theme/utils/ColorUtils';
import * as FormUtils from '@app/lib/forms';
import {getAcceptString} from '@fluxer/constants/src/AssetFormatPolicy';
import type {InstanceConfigResponse} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {type RefObject, useCallback} from 'react';

const logger = new Logger('SelfHostedSetupWizardGate');

interface BrandingStepProps {
	config: InstanceConfigResponse | null;
	formRef: RefObject<HTMLFormElement | null>;
	disabled: boolean;
	error: string | null;
	onSubmit: (submit: () => Promise<void>) => Promise<void>;
	onSave: (patch: Parameters<typeof updateInstanceConfig>[0]) => Promise<boolean>;
	onConfigUpdate: (config: InstanceConfigResponse) => void;
	onAdvance: () => void;
	onError: (error: string) => void;
}

export const BrandingStep = observer(
	({config, formRef, disabled, error, onSubmit, onSave, onConfigUpdate, onAdvance, onError}: BrandingStepProps) => {
		const {i18n} = useLingui();
		const {productName, themeColor, setThemeColor, assets, updateAsset} = useSetupBrandingDraft();
		const saveLook = async () => {
			if (!config) return;
			for (const asset of assets) {
				const original = brandingAssetUrl(config, asset.kind);
				const image = asset.preview ?? (asset.url === null && original !== null ? null : undefined);
				if (image === undefined) continue;
				try {
					const next = await uploadBrandingAsset(asset.kind, image);
					updateAsset(asset.kind, {url: brandingAssetUrl(next, asset.kind), preview: null, error: null});
					onConfigUpdate(next);
				} catch (error) {
					logger.error('Failed to upload a branding image', error);
					updateAsset(asset.kind, {error: 'not_saved'});
					onError(FormUtils.extractErrorMessage(i18n, error));
					return;
				}
			}
			const saved = await onSave({
				app_public: {branding: {theme_color: themeColor === null ? null : int2hex(themeColor)}},
			});
			if (saved) onAdvance();
		};
		const handleUploadAsset = useCallback(
			async (kind: SetupBrandingAssetKind, droppedFile?: File) => {
				let file = droppedFile;
				if (!file) {
					[file] = await openFilePicker({accept: getAcceptString(brandingAssetPolicyKind(kind))});
				}
				if (!file) return;
				const error = validateBrandingFile(kind, file);
				if (error) {
					updateAsset(kind, {error});
					return;
				}
				updateAsset(kind, {reading: true, error: null});
				try {
					const dataUrl = await fileToBase64(file);
					updateAsset(kind, {preview: dataUrl, reading: false});
				} catch (readError) {
					logger.error('Failed to read branding asset file', readError);
					updateAsset(kind, {reading: false, error: 'unreadable'});
				}
			},
			[updateAsset],
		);

		return (
			<BrandingFields
				productName={productName}
				themeColor={themeColor}
				assets={assets}
				formRef={formRef}
				disabled={disabled}
				error={error}
				onSubmit={(event) => {
					event.preventDefault();
					void onSubmit(saveLook);
				}}
				onThemeColorChange={setThemeColor}
				onUploadAsset={handleUploadAsset}
				onClearAsset={(kind) => updateAsset(kind, {preview: null, url: null, error: null})}
				onAssetImageError={(kind) => updateAsset(kind, {preview: null, error: 'unreadable'})}
				data-flx="app.setup.setup-branding-step.branding-step.branding-fields.prevent-default"
			/>
		);
	},
);
