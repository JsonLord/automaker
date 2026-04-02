import os
import json
import sys

def main():
    if len(sys.argv) < 3:
        print("Usage: python update_settings.py <data_dir> <model_id>")
        sys.exit(1)

    data_dir = sys.argv[1]
    model_id = sys.argv[2]
    settings_path = os.path.join(data_dir, 'settings.json')

    if not os.path.exists(settings_path):
        print(f"Settings file not found at {settings_path}")
        # Create default settings if it doesn't exist?
        # Actually, if it doesn't exist, we'll just skip it for now or create a minimal one
        settings = {
            "version": 6,
            "setupComplete": True,
            "isFirstRun": False,
            "theme": "dark",
            "phaseModels": {}
        }
    else:
        with open(settings_path, 'r') as f:
            settings = json.load(f)

    # Update defaultFeatureModel
    settings['defaultFeatureModel'] = {"model": model_id}

    # Update phaseModels
    if 'phaseModels' not in settings:
        settings['phaseModels'] = {}

    phases = [
        "enhancementModel", "fileDescriptionModel", "imageDescriptionModel",
        "validationModel", "specGenerationModel", "featureGenerationModel",
        "backlogPlanningModel", "projectAnalysisModel", "ideationModel",
        "memoryExtractionModel", "commitMessageModel", "prDescriptionModel"
    ]

    for phase in phases:
        settings['phaseModels'][phase] = {"model": model_id}

    # Update OpenCode settings
    settings['opencodeDefaultModel'] = model_id
    if 'enabledOpencodeModels' not in settings:
        settings['enabledOpencodeModels'] = []
    if model_id not in settings['enabledOpencodeModels']:
        settings['enabledOpencodeModels'].append(model_id)

    with open(settings_path, 'w') as f:
        json.dump(settings, f, indent=2)
    print(f"Successfully updated settings with model {model_id}")

if __name__ == "__main__":
    main()
