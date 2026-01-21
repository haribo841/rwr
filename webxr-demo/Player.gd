extends CharacterBody3D

@export var move_speed: float = 2.0
@export var gravity: float = 9.8
@export var deadzone: float = 0.15

@onready var xr_origin: XROrigin3D = $XROrigin3D
@onready var xr_camera: XRCamera3D = $XROrigin3D/XRCamera3D
@onready var left_controller: XRController3D = $XROrigin3D/LeftController

func _physics_process(delta: float) -> void:
    # --- grawitacja ---
    if not is_on_floor():
        velocity.y -= gravity * delta
    else:
        velocity.y = -0.1

    # --- gałka (z fallback) ---
    var stick := _get_left_stick()

    if stick.length() < deadzone:
        stick = Vector2.ZERO

    # --- kierunek względem kamery ---
    var cam_basis: Basis = xr_camera.global_transform.basis
    var forward: Vector3 = -cam_basis.z
    var right: Vector3 = cam_basis.x
    forward.y = 0.0
    right.y = 0.0
    forward = forward.normalized()
    right = right.normalized()

    # stick.y zwykle u góry = -1
    var move_dir: Vector3 = (right * stick.x) + (forward * (stick.y))

    if move_dir.length() > 0.0:
        move_dir = move_dir.normalized()
        velocity.x = move_dir.x * move_speed
        velocity.z = move_dir.z * move_speed
    else:
        velocity.x = 0.0
        velocity.z = 0.0

    move_and_slide()

func _get_left_stick() -> Vector2:
    # Najczęściej działa:
    var v := left_controller.get_vector2("thumbstick")
    if v != Vector2.ZERO:
        return v

    # Czasem w WebXR/konfiguracjach:
    v = left_controller.get_vector2("primary")
    if v != Vector2.ZERO:
        return v

    v = left_controller.get_vector2("trackpad")
    return v
