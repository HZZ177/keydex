import random
from pathlib import Path

from backend.app.keydex import KeydexLayerProfile
from backend.app.keydex.skills import (
    SkillDefinition,
    SkillLayerCatalog,
    resolve_effective_skill_catalog,
)


def _skill(root: Path, name: str, source: str) -> SkillDefinition:
    logical_root = "builtin" if source == "builtin" else ".keydex"
    return SkillDefinition(
        name=name,
        description=f"{source}:{name}",
        source=source,  # type: ignore[arg-type]
        root_dir=root / "skills" / name,
        entry_file=root / "skills" / name / "SKILL.md",
        relative_entry=f"{logical_root}/skills/{name}/SKILL.md",
    )


def _catalog(
    tmp_path: Path,
    scope: str,
    *names: str,
    enabled: bool = True,
    available: bool = True,
    inherit_system: bool = True,
    blocked_names: frozenset[str] = frozenset(),
) -> SkillLayerCatalog:
    root = tmp_path / scope
    profile = KeydexLayerProfile(
        scope=scope,  # type: ignore[arg-type]
        root=root,
        enabled=enabled,
        available=available,
        inherit_system=inherit_system,
    )
    return SkillLayerCatalog(
        profile=profile,
        skills={name: _skill(root, name, scope) for name in names} if enabled else {},
        blocked_names=blocked_names,
    )


def test_t14_old_workspace_defaults_to_inheriting_system(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global"),
        _catalog(tmp_path, "workspace", "local"),
    )

    assert list(effective.skills) == ["global", "local"]


def test_t15_workspace_can_disable_system_inheritance(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global"),
        _catalog(tmp_path, "workspace", "local", inherit_system=False),
    )

    assert list(effective.skills) == ["local"]


def test_t16_disabled_workspace_layer_still_inherits_system(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global"),
        _catalog(tmp_path, "workspace", enabled=False, inherit_system=True),
    )

    assert list(effective.skills) == ["global"]


def test_t17_disabled_system_does_not_disable_workspace(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", enabled=False),
        _catalog(tmp_path, "workspace", "local"),
    )

    assert list(effective.skills) == ["local"]


def test_t18_invalid_workspace_fails_closed_without_system_fallback(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global"),
        _catalog(tmp_path, "workspace", available=False),
    )

    assert effective.available is False
    assert effective.skills == {}


def test_t19_invalid_workspace_does_not_mutate_system_catalog(tmp_path: Path) -> None:
    system = _catalog(tmp_path, "system", "global")
    resolve_effective_skill_catalog(system, _catalog(tmp_path, "workspace", available=False))

    assert list(system.skills) == ["global"]


def test_t20_valid_workspace_skill_overrides_same_system_name(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "shared"),
        _catalog(tmp_path, "workspace", "shared"),
    )

    assert list(effective.skills) == ["shared"]
    assert effective.skills["shared"].source == "workspace"


def test_t21_non_overridden_system_skill_is_inherited(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global", "shared"),
        _catalog(tmp_path, "workspace", "shared"),
    )

    assert effective.skills["global"].source == "system"


def test_t22_invalid_workspace_candidate_blocks_same_system_name(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "shared"),
        _catalog(tmp_path, "workspace", blocked_names=frozenset({"shared"})),
    )

    assert effective.skills == {}
    assert effective.shadowed_names == frozenset({"shared"})
    assert effective.diagnostics[-1].code == "skill_shadow_barrier"


def test_t23_shadow_barrier_does_not_remove_other_names(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global", "shared"),
        _catalog(tmp_path, "workspace", blocked_names=frozenset({"shared"})),
    )

    assert list(effective.skills) == ["global"]


def test_t24_repaired_workspace_candidate_becomes_winner(tmp_path: Path) -> None:
    system = _catalog(tmp_path, "system", "shared")
    repaired = resolve_effective_skill_catalog(
        system,
        _catalog(tmp_path, "workspace", "shared"),
    )

    assert repaired.skills["shared"].source == "workspace"


def test_t25_deleting_workspace_override_restores_system_winner(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "shared"),
        _catalog(tmp_path, "workspace"),
    )

    assert effective.skills["shared"].source == "system"


def test_t26_workspace_rename_restores_old_and_adds_new_name(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "old"),
        _catalog(tmp_path, "workspace", "new"),
    )

    assert list(effective.skills) == ["new", "old"]
    assert effective.skills["old"].source == "system"


def test_t27_canonical_casefold_override_is_consistent(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "Shared"),
        _catalog(tmp_path, "workspace", "shared"),
    )

    assert list(effective.skills) == ["shared"]


def test_t28_result_order_is_stable_and_inputs_are_not_mutated(tmp_path: Path) -> None:
    expected = ["Alpha", "beta", "middle", "zeta"]
    for seed in range(8):
        system_names = ["zeta", "Alpha"]
        workspace_names = ["middle", "beta"]
        random.Random(seed).shuffle(system_names)
        random.Random(seed + 100).shuffle(workspace_names)
        system = _catalog(tmp_path, f"system-{seed}", *system_names)
        workspace = _catalog(tmp_path, f"workspace-{seed}", *workspace_names)

        effective = resolve_effective_skill_catalog(system, workspace)

        assert list(effective.skills) == expected
        assert set(system.skills) == {"zeta", "Alpha"}
        assert set(workspace.skills) == {"middle", "beta"}


def test_t29_winner_preserves_real_source_and_logical_locator(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global"),
    )

    winner = effective.skills["global"]
    assert winner.source == "system"
    assert winner.relative_entry == ".keydex/skills/global/SKILL.md"


def test_builtin_is_the_lowest_priority_layer(tmp_path: Path) -> None:
    builtin = _catalog(tmp_path, "builtin", "builtin-only", "shared")

    system_effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "shared", "system-only"),
        builtin=builtin,
    )
    workspace_effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "shared", "system-only"),
        _catalog(tmp_path, "workspace", "shared", "workspace-only"),
        builtin=builtin,
    )

    assert system_effective.skills["shared"].source == "system"
    assert workspace_effective.skills["shared"].source == "workspace"
    assert workspace_effective.skills["builtin-only"].source == "builtin"
    assert workspace_effective.skills["system-only"].source == "system"


def test_disabling_system_inheritance_keeps_builtin_skills(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "system-only", "shared"),
        _catalog(tmp_path, "workspace", "workspace-only", inherit_system=False),
        builtin=_catalog(tmp_path, "builtin", "builtin-only", "shared"),
    )

    assert list(effective.skills) == ["builtin-only", "shared", "workspace-only"]
    assert effective.skills["shared"].source == "builtin"


def test_invalid_system_candidate_blocks_same_name_builtin(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", blocked_names=frozenset({"shared"})),
        builtin=_catalog(tmp_path, "builtin", "shared", "visible"),
    )

    assert list(effective.skills) == ["visible"]
    assert effective.shadowed_names == frozenset({"shared"})
    assert effective.diagnostics[-1].details["blocking_source"] == "system"


def test_invalid_workspace_candidate_blocks_system_and_builtin_without_mutation(
    tmp_path: Path,
) -> None:
    builtin = _catalog(tmp_path, "builtin", "shared")
    system = _catalog(tmp_path, "system", "shared")
    effective = resolve_effective_skill_catalog(
        system,
        _catalog(tmp_path, "workspace", blocked_names=frozenset({"shared"})),
        builtin=builtin,
    )

    assert effective.skills == {}
    assert list(builtin.skills) == ["shared"]
    assert list(system.skills) == ["shared"]
    assert effective.diagnostics[-1].details["blocked_sources"] == ["system"]


def test_unavailable_builtin_does_not_disable_valid_user_layers(tmp_path: Path) -> None:
    effective = resolve_effective_skill_catalog(
        _catalog(tmp_path, "system", "global"),
        builtin=_catalog(tmp_path, "builtin", available=False),
    )

    assert effective.available is True
    assert list(effective.skills) == ["global"]
