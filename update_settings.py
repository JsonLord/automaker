import os
import json
import sys
import tempfile

def remove_managed_profiles(settings):
    settings["claudeCompatibleProviders"] = [
        provider for provider in settings.get("claudeCompatibleProviders", [])
        if provider.get("id") not in ("automaker-compatible", "automaker-compatible-provider")
    ]


def write_atomic(filename, settings):
    directory = os.path.dirname(filename)
    fd, temp_path = tempfile.mkstemp(prefix="settings.json.tmp.", dir=directory)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(settings, f, indent=2)
        os.replace(temp_path, filename)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


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
            raise RuntimeError("Cannot read settings; refusing to overwrite them") from e

    # OpenCode provider/model identity; credentials remain exclusively in env.
    bare_model = model.removeprefix("automaker-compatible/")
    canonical_model = f"automaker-compatible/{bare_model}"
    model_entry = {"model": canonical_model, "providerId": "automaker-compatible"}
    remove_managed_profiles(settings)

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
        # Sanitize existing generated-profile backups without copying the old
        # inline key into a new backup during this migration.
        for index in range(1, 4):
            backup_file = f"{settings_file}.bak{index}"
            if os.path.exists(backup_file):
                with open(backup_file) as f:
                    backup = json.load(f)
                remove_managed_profiles(backup)
                write_atomic(backup_file, backup)
        write_atomic(settings_file, settings)
        print(f"Updated settings with model {canonical_model} across all phase models and profiles (OpenCode credentials stay in environment)")
    except Exception as e:
        raise RuntimeError("Cannot write OpenCode settings") from e

if __name__ == "__main__":
    main()
