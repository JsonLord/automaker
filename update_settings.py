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

    # Format canonical OpenCode model string for automaker-compatible provider
    if "/" not in model and not model.startswith("automaker-compatible/"):
        canonical_model = f"automaker-compatible/{model}"
    else:
        canonical_model = model

    # Set enhancement model
    settings["enhancementModel"] = canonical_model
    # Set default feature model
    settings["defaultFeatureModel"] = {"model": canonical_model, "provider": "opencode"}
    
    # Set phase models
    if "phaseModels" not in settings:
        settings["phaseModels"] = {}

    settings["phaseModels"]["specGenerationModel"] = canonical_model
    settings["phaseModels"]["planningModel"] = canonical_model
    settings["phaseModels"]["implementationModel"] = canonical_model
    settings["phaseModels"]["reviewModel"] = canonical_model
    settings["phaseModels"]["ideationModel"] = canonical_model

    # Update active model in profiles if they exist
    if "profiles" in settings:
        for profile in settings["profiles"]:
            profile["model"] = canonical_model
            profile["provider"] = "opencode"

    try:
        os.makedirs(data_dir, exist_ok=True)
        with open(settings_file, "w") as f:
            json.dump(settings, f, indent=2)
        print(f"Updated settings with model {model} and forced all phases/profiles to use it via OpenCode")
    except Exception as e:
        print(f"Error writing settings: {e}")

if __name__ == "__main__":
    main()
