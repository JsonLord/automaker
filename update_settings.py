import os
import json
import sys

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 update_settings.py <DATA_DIR> <MODEL>")
        sys.exit(1)

    data_dir = sys.argv[1]
    model = sys.argv[2]
    settings_file = os.path.join(data_dir, "settings.json")

    settings = {}
    if os.path.exists(settings_file):
        try:
            with open(settings_file, "r") as f:
                settings = json.load(f)
        except Exception as e:
            print(f"Error reading settings: {e}")

    # Format canonical model string for automaker-compatible provider
    if "/" not in model and not model.startswith("automaker-compatible/"):
        canonical_model = f"automaker-compatible/{model}"
    else:
        canonical_model = model

    model_entry = {"model": canonical_model, "providerId": "automaker-compatible"}

    comp_url = os.environ.get("COMPATIBLE_URL", os.environ.get("OPENAI_COMPATIBLE_URL", ""))
    comp_api_key = os.environ.get("COMPATIBLE_API_KEY", os.environ.get("OPENAI_COMPATIBLE_API_KEY", os.environ.get("OPENAI_COMPATIBLE_API", "")))

    comp_provider = {
        "id": "automaker-compatible-provider",
        "name": "Automaker Compatible",
        "providerType": "custom",
        "apiKeySource": "inline",
        "baseUrl": comp_url,
        "apiKey": comp_api_key,
        "enabled": True,
        "models": [
            {"id": canonical_model, "displayName": canonical_model},
            {"id": model, "displayName": model},
            {"id": "test-blablador", "displayName": "test-blablador"},
            {"id": "automaker-compatible/test-blablador", "displayName": "Automaker Compatible test-blablador"},
            {"id": "auto", "displayName": "auto"},
            {"id": "automaker-compatible/auto", "displayName": "Automaker Compatible auto"}
        ]
    }

    settings["claudeCompatibleProviders"] = [comp_provider]

    # Set enhancement model
    settings["enhancementModel"] = canonical_model
    # Set default feature model
    settings["defaultFeatureModel"] = model_entry

    # Set phase models for all application tasks
    if "phaseModels" not in settings:
        settings["phaseModels"] = {}

    phase_keys = [
        "enhancementModel",
        "fileDescriptionModel",
        "imageDescriptionModel",
        "validationModel",
        "specGenerationModel",
        "featureGenerationModel",
        "backlogPlanningModel",
        "projectAnalysisModel",
        "ideationModel",
        "memoryExtractionModel",
        "commitMessageModel",
        "prDescriptionModel",
        "planningModel",
        "implementationModel",
        "reviewModel",
    ]

    for key in phase_keys:
        settings["phaseModels"][key] = model_entry

    # Update active model in profiles if they exist
    if "profiles" in settings:
        for profile in settings["profiles"]:
            profile["model"] = canonical_model
            profile["providerId"] = "automaker-compatible"

    try:
        os.makedirs(data_dir, exist_ok=True)
        with open(settings_file, "w") as f:
            json.dump(settings, f, indent=2)
        print(f"Updated settings with model {canonical_model} across all phase models, profiles, and claudeCompatibleProviders")
    except Exception as e:
        print(f"Error writing settings: {e}")

if __name__ == "__main__":
    main()
